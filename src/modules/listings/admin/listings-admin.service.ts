import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AdminActionType,
  AuditTargetType,
} from '../../admin/audit/audit.enums.js';
import { AuditService } from '../../admin/audit/audit.service.js';
import {
  cursorTimestampSql,
  decodeCursor,
  encodeCursor,
} from '../../admin/pagination.js';
import { PhotoStorage } from '../../photos/photo-storage.js';
import { PropertyPhoto } from '../../photos/property-photo.entity.js';
import type { UserStatus, VerificationStatus } from '../../users/user.enums.js';
import type { PhotoDto } from '../dto/listing.dto.js';
import { listingNotFound } from '../listing-state.js';
import { ListingHistory } from '../listing-history.entity.js';
import {
  ACTIVE_LISTING_STATUSES,
  type Amenity,
  type CloseReason,
  type ListerRelation,
  ListingStatus,
  type PropertyType,
  type StaffReasonCode,
} from '../listings.enums.js';
import {
  type AdminListingDetailDto,
  type AdminListingQuery,
  type AdminQueueItemDto,
  type AdminQueuePageDto,
  DEFAULT_LISTING_QUEUE_PAGE,
  type RevealedPhoneDto,
} from './listings-admin.dto.js';
import { reviewFlags } from './review-flags.js';

/** Queue order: oldest submission first; never-submitted rows (none in practice) by creation. */
const ORDER_KEY = 'coalesce(l.submitted_at, l.created_at)';

// The lister's active listings, counting this one if it's active (R1 MANY_ACTIVE_LISTINGS).
const ACTIVE_COUNT = `(SELECT count(*)::int FROM listings l2 JOIN properties p2 ON p2.id = l2.property_id
   WHERE p2.lister_id = p.lister_id AND l2.status = ANY ('{${ACTIVE_LISTING_STATUSES.join(',')}}'::listing_status[]))`;

interface ListingRow {
  id: string;
  status: ListingStatus;
  version: number;
  submitted_at: Date | null;
  monthly_rent_birr: number | null;
  type: PropertyType | null;
  bedrooms: number | null;
  description: string | null;
  landmark: string | null;
  unlisted_neighbourhood_name: string | null;
  sub_city_name_en: string | null;
  neighbourhood_name_en: string | null;
  lister_id: string;
  full_name: string | null;
  active_listings: number;
}

const SELECT = `SELECT l.id, l.status, l.version, l.submitted_at, l.monthly_rent_birr,
    p.type, p.bedrooms, p.description, p.landmark, p.unlisted_neighbourhood_name,
    s.name_en AS sub_city_name_en, n.name_en AS neighbourhood_name_en,
    p.lister_id, u.full_name, ${ACTIVE_COUNT} AS active_listings`;
const FROM = `FROM listings l
    JOIN properties p ON p.id = l.property_id
    JOIN users u ON u.id = p.lister_id
    LEFT JOIN neighbourhoods n ON n.id = p.neighbourhood_id
    LEFT JOIN sub_cities s ON s.id = n.sub_city_id`;

/**
 * Staff review: the queue and one listing with everything the reviewer needs (spec section 8,
 * R1, R6). Reads only; any staff role. The decisions (approve, reject, take down) are T4.2.
 */
@Injectable()
export class ListingsAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    private readonly audit: AuditService,
  ) {}

  /** GET /admin/listings: one status (pending_review by default), oldest submission first. */
  async queue(query: AdminListingQuery): Promise<AdminQueuePageDto> {
    const limit = query.limit ?? DEFAULT_LISTING_QUEUE_PAGE;
    const params: unknown[] = [query.status ?? ListingStatus.PendingReview];
    const where = [`l.status = $1::listing_status`];
    if (query.after) {
      const cursor = decodeCursor(query.after);
      params.push(cursor.createdAt, cursor.id);
      where.push(
        `(${ORDER_KEY}, l.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1);

    const rows = await this.dataSource.query<
      (ListingRow & {
        property_id: string;
        photo_count: number;
        cover_key: string | null;
        cursor_ts: string;
      })[]
    >(
      `${SELECT}, l.property_id,
         (SELECT count(*)::int FROM property_photos ph WHERE ph.property_id = p.id) AS photo_count,
         (SELECT ph.storage_key FROM property_photos ph WHERE ph.property_id = p.id
          ORDER BY ph.position LIMIT 1) AS cover_key,
         ${cursorTimestampSql(ORDER_KEY)} AS cursor_ts
       ${FROM}
       WHERE ${where.join(' AND ')}
       ORDER BY ${ORDER_KEY}, l.id
       LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items: AdminQueueItemDto[] = [];
    for (const row of page)
      items.push({
        id: row.id,
        status: row.status,
        version: row.version,
        submittedAt: row.submitted_at,
        type: row.type,
        bedrooms: row.bedrooms,
        monthlyRentBirr: row.monthly_rent_birr,
        subCityNameEn: row.sub_city_name_en,
        neighbourhoodNameEn: row.neighbourhood_name_en,
        photoCount: row.photo_count,
        coverUrl: row.cover_key
          ? await this.storage.signedUrl(row.cover_key)
          : null,
        listerId: row.lister_id,
        listerFullName: row.full_name,
        flags: flagsOf(row),
      });
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.cursor_ts, last.id)
          : null,
    };
  }

  /** GET /admin/listings/:id: everything the reviewer needs, private fields included (G3). */
  async detail(id: string): Promise<AdminListingDetailDto> {
    const [row] = await this.dataSource.query<
      (ListingRow & {
        advance_months: number | null;
        negotiable: boolean | null;
        available_from: string | null;
        needs_review: boolean;
        close_reason: CloseReason | null;
        staff_reason_code: StaffReasonCode | null;
        lister_note: string | null;
        published_at: Date | null;
        created_at: Date;
        property_id: string;
        neighbourhood_id: string | null;
        bathrooms: number | null;
        furnished: boolean | null;
        separate_water_meter: boolean | null;
        separate_electricity_meter: boolean | null;
        size_m2: number | null;
        floor: number | null;
        amenities: Amenity[];
        lister_relation: ListerRelation | null;
        lat: number | null;
        lng: number | null;
        approx_lat: number | null;
        approx_lng: number | null;
        verification_status: VerificationStatus;
        user_status: UserStatus;
      })[]
    >(
      `${SELECT}, l.advance_months, l.negotiable, l.available_from::text, l.needs_review,
         l.close_reason, l.staff_reason_code, l.lister_note, l.published_at, l.created_at,
         l.property_id, p.neighbourhood_id, p.bathrooms, p.furnished, p.separate_water_meter,
         p.separate_electricity_meter, p.size_m2, p.floor, p.amenities::text[] AS amenities,
         p.lister_relation,
         ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
         ST_Y(p.approx_location::geometry) AS approx_lat, ST_X(p.approx_location::geometry) AS approx_lng,
         u.verification_status, u.status AS user_status
       ${FROM}
       WHERE l.id = $1`,
      [id],
    );
    if (!row) throw listingNotFound();

    const [photos, others, history] = await Promise.all([
      this.photosOf(row.property_id),
      this.dataSource.query<
        {
          id: string;
          status: ListingStatus;
          monthly_rent_birr: number | null;
          submitted_at: Date | null;
          sub_city_name_en: string | null;
          neighbourhood_name_en: string | null;
        }[]
      >(
        `SELECT l.id, l.status, l.monthly_rent_birr, l.submitted_at,
           s.name_en AS sub_city_name_en, n.name_en AS neighbourhood_name_en
         FROM listings l JOIN properties p ON p.id = l.property_id
         LEFT JOIN neighbourhoods n ON n.id = p.neighbourhood_id
         LEFT JOIN sub_cities s ON s.id = n.sub_city_id
         WHERE p.lister_id = $1 AND l.id <> $2 AND l.status <> 'draft'
         ORDER BY coalesce(l.submitted_at, l.created_at) DESC, l.id`,
        [row.lister_id, id],
      ),
      this.dataSource.manager.find(ListingHistory, {
        where: { listingId: id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
    ]);

    const point = (lat: number | null, lng: number | null) =>
      lat === null || lng === null ? null : { lat, lng };
    return {
      id: row.id,
      status: row.status,
      version: row.version,
      monthlyRentBirr: row.monthly_rent_birr,
      advanceMonths: row.advance_months,
      negotiable: row.negotiable,
      availableFrom: row.available_from,
      needsReview: row.needs_review,
      closeReason: row.close_reason,
      staffReasonCode: row.staff_reason_code,
      listerNote: row.lister_note,
      submittedAt: row.submitted_at,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      property: {
        id: row.property_id,
        subCityNameEn: row.sub_city_name_en,
        neighbourhoodId: row.neighbourhood_id,
        neighbourhoodNameEn: row.neighbourhood_name_en,
        unlistedNeighbourhoodName: row.unlisted_neighbourhood_name,
        type: row.type,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        furnished: row.furnished,
        separateWaterMeter: row.separate_water_meter,
        separateElectricityMeter: row.separate_electricity_meter,
        sizeM2: row.size_m2,
        floor: row.floor,
        amenities: row.amenities,
        description: row.description,
        location: point(row.lat, row.lng),
        approxLocation: point(row.approx_lat, row.approx_lng),
        landmark: row.landmark,
        listerRelation: row.lister_relation,
        photos,
      },
      lister: {
        id: row.lister_id,
        fullName: row.full_name,
        verificationStatus: row.verification_status,
        status: row.user_status,
      },
      otherListings: others.map((o) => ({
        id: o.id,
        status: o.status,
        monthlyRentBirr: o.monthly_rent_birr,
        submittedAt: o.submitted_at,
        subCityNameEn: o.sub_city_name_en,
        neighbourhoodNameEn: o.neighbourhood_name_en,
      })),
      history: history.map((h) => ({
        event: h.event,
        oldStatus: h.oldStatus,
        newStatus: h.newStatus,
        oldMonthlyRentBirr: h.oldMonthlyRentBirr,
        newMonthlyRentBirr: h.newMonthlyRentBirr,
        oldAvailableFrom: h.oldAvailableFrom,
        newAvailableFrom: h.newAvailableFrom,
        closeReason: h.closeReason,
        staffReasonCode: h.staffReasonCode,
        actorType: h.actorType,
        actorId: h.actorId,
        createdAt: h.createdAt,
      })),
      flags: flagsOf(row),
    };
  }

  /**
   * The lister's phone, for a reviewer who wants to call about a suspicious listing (decided
   * 2026-11-24): never part of the detail, moderator and above, and every reveal is audited in
   * the same transaction (S1). The audit row says who looked at which listing and why; it never
   * holds the number.
   */
  async revealListerPhone(
    adminId: string,
    id: string,
    note?: string,
  ): Promise<RevealedPhoneDto> {
    return this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query<{ phone: string }[]>(
        `SELECT u.phone FROM listings l
         JOIN properties p ON p.id = l.property_id JOIN users u ON u.id = p.lister_id
         WHERE l.id = $1`,
        [id],
      );
      if (!row) throw listingNotFound();
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.ListingRevealListerPhone,
        targetType: AuditTargetType.Listing,
        targetId: id,
        details: note ? { note } : {},
      });
      return { phone: row.phone };
    });
  }

  /** R6: staff see photos through short-lived signed links, live or not. */
  private async photosOf(propertyId: string): Promise<PhotoDto[]> {
    const photos = await this.dataSource.manager.find(PropertyPhoto, {
      where: { propertyId },
      order: { position: 'ASC' },
    });
    const views: PhotoDto[] = [];
    for (const photo of photos)
      views.push({
        id: photo.id,
        position: photo.position,
        width: photo.width,
        height: photo.height,
        url: await this.storage.signedUrl(photo.storageKey),
      });
    return views;
  }
}

const flagsOf = (row: ListingRow) =>
  reviewFlags({
    activeListings: row.active_listings,
    description: row.description,
    landmark: row.landmark,
    unlistedNeighbourhoodName: row.unlisted_neighbourhood_name,
  });
