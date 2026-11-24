import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { EnvironmentVariables } from '../../../config/env.validation.js';
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
import { UserStatus, VerificationStatus } from '../../users/user.enums.js';
import type { PhotoDto } from '../dto/listing.dto.js';
import {
  listingNotFound,
  lockListingForStaff,
  PUBLISHED,
  recordStatusChange,
} from '../listing-state.js';
import { ListingHistory } from '../listing-history.entity.js';
import { Listing } from '../listing.entity.js';
import { PublicPhotos } from '../public-photos.js';
import {
  ACTIVE_LISTING_STATUSES,
  ActorType,
  type Amenity,
  CloseReason,
  type ListerRelation,
  ListingStatus,
  type PropertyType,
  StaffReasonCode,
} from '../listings.enums.js';
import {
  type AdminListingDetailDto,
  type AdminListingQuery,
  type ApproveListingDto,
  type RejectListingDto,
  type TakedownListingDto,
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
 * Staff review (spec section 8): the queue and one listing with everything the reviewer needs
 * (R1, R6; any staff role), the phone reveal, and the decisions (R2–R5; moderator and above):
 * approve, reject, take down. Each decision locks the lister and the listing (the same order as
 * the lister's own changes), checks, changes, writes listing_history with the staff member as the
 * actor and admin_actions (S1), all in one transaction.
 */
@Injectable()
export class ListingsAdminService {
  private readonly maxActive: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    private readonly audit: AuditService,
    private readonly publicPhotos: PublicPhotos,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxActive = config.get('LISTING_MAX_ACTIVE_PER_USER', { infer: true });
  }

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

  /**
   * Approve (R2–R4): pending_review → live. Checks the lister again (R3), publishes the photos
   * inside the transaction (a storage failure aborts it: 503 STORAGE_UNAVAILABLE), keeps the
   * original published_at on a re-approval and restarts the freshness clock (last_confirmed_at;
   * both decided 2026-11-24).
   * Errors: 404 LISTING_NOT_FOUND; 409 ALREADY_DECIDED, LISTING_NOT_REVIEWABLE, LISTING_CHANGED,
   * LISTER_NOT_ELIGIBLE, ACTIVE_LISTING_LIMIT.
   */
  async approve(
    adminId: string,
    id: string,
    body: ApproveListingDto,
  ): Promise<AdminListingDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockReviewable(manager, id, body.version);
      if (
        locked.lister.status !== UserStatus.Active ||
        locked.lister.verification_status !== VerificationStatus.Approved
      )
        throw new ConflictException({ code: 'LISTER_NOT_ELIGIBLE' });
      // This listing is already counted (it's in review); approval only keeps it active.
      if ((await activeCount(manager, locked.lister_id)) > this.maxActive)
        throw new ConflictException({
          code: 'ACTIVE_LISTING_LIMIT',
          max: this.maxActive,
        });

      await manager.update(Listing, id, {
        status: ListingStatus.Live,
        reviewedByAdminId: adminId,
        publishedAt: () => 'coalesce(published_at, now())',
        lastConfirmedAt: () => 'now()',
      });
      await recordStatusChange(
        manager,
        id,
        ListingStatus.PendingReview,
        ListingStatus.Live,
        adminId,
        { actorType: ActorType.Admin },
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.ListingApprove,
        targetType: AuditTargetType.Listing,
        targetId: id,
        details: body.note ? { note: body.note } : {},
      });
      await this.publicPhotos.publish(manager, locked.property_id);
    });
    return this.detail(id);
  }

  /**
   * Reject (R2, R4): pending_review → rejected, with a reason code the lister sees, an optional
   * lister note (not with GUIDELINES) and a staff-only note.
   * Errors: 400 LISTER_NOTE_NOT_ALLOWED; 404 LISTING_NOT_FOUND; 409 ALREADY_DECIDED,
   * LISTING_NOT_REVIEWABLE, LISTING_CHANGED.
   */
  async reject(
    adminId: string,
    id: string,
    body: RejectListingDto,
  ): Promise<AdminListingDetailDto> {
    assertListerNoteAllowed(body);
    await this.dataSource.transaction(async (manager) => {
      await this.lockReviewable(manager, id, body.version);
      await manager.update(Listing, id, {
        status: ListingStatus.Rejected,
        reviewedByAdminId: adminId,
        staffReasonCode: body.reasonCode,
        listerNote: body.listerNote ?? null,
      });
      await recordStatusChange(
        manager,
        id,
        ListingStatus.PendingReview,
        ListingStatus.Rejected,
        adminId,
        { actorType: ActorType.Admin, staffReasonCode: body.reasonCode },
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.ListingReject,
        targetType: AuditTargetType.Listing,
        targetId: id,
        details: decisionDetails(body),
      });
    });
    return this.detail(id);
  }

  /**
   * Take down (R5): a live or stale listing → removed, close reason staff_takedown, with a reason
   * code, an optional lister note (not with GUIDELINES) and a staff-only note. After the commit,
   * its photos are unpublished and the CDN is asked to forget them (P5; cached copies would
   * otherwise last up to a day). No version: a takedown doesn't depend on what the lister changed.
   * Errors: 400 LISTER_NOTE_NOT_ALLOWED; 404 LISTING_NOT_FOUND; 409 LISTING_NOT_REVIEWABLE (not
   * live or stale).
   */
  async takedown(
    adminId: string,
    id: string,
    body: TakedownListingDto,
  ): Promise<AdminListingDetailDto> {
    assertListerNoteAllowed(body);
    const propertyId = await this.dataSource.transaction(async (manager) => {
      const locked = await lockListingForStaff(manager, id);
      if (!PUBLISHED.includes(locked.status))
        throw new ConflictException({ code: 'LISTING_NOT_REVIEWABLE' });
      await manager.update(Listing, id, {
        status: ListingStatus.Removed,
        closeReason: CloseReason.StaffTakedown,
        closedAt: () => 'now()',
        reviewedByAdminId: adminId,
        staffReasonCode: body.reasonCode,
        listerNote: body.listerNote ?? null,
      });
      await recordStatusChange(
        manager,
        id,
        locked.status,
        ListingStatus.Removed,
        adminId,
        {
          actorType: ActorType.Admin,
          closeReason: CloseReason.StaffTakedown,
          staffReasonCode: body.reasonCode,
        },
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.ListingTakedown,
        targetType: AuditTargetType.Listing,
        targetId: id,
        details: decisionDetails(body),
      });
      return locked.property_id;
    });
    await this.publicPhotos.unpublish(propertyId, { purgeCdn: true });
    return this.detail(id);
  }

  /**
   * R2 for approve and reject: locked, still in review, and the version the reviewer saw. A
   * listing a reviewer already approved or rejected is ALREADY_DECIDED (two reviewers at once:
   * the lock makes the second see the first); any other state is LISTING_NOT_REVIEWABLE.
   */
  private async lockReviewable(
    manager: EntityManager,
    id: string,
    version: number,
  ) {
    const locked = await lockListingForStaff(manager, id);
    if (
      locked.status === ListingStatus.Live ||
      locked.status === ListingStatus.Rejected
    )
      throw new ConflictException({ code: 'ALREADY_DECIDED' });
    if (locked.status !== ListingStatus.PendingReview)
      throw new ConflictException({ code: 'LISTING_NOT_REVIEWABLE' });
    if (locked.version !== version)
      throw new ConflictException({
        code: 'LISTING_CHANGED',
        version: locked.version,
      });
    return locked;
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

/**
 * Hard rule 10: suspected fraud (GUIDELINES) is never explained to the lister, so a GUIDELINES
 * decision can't carry a lister note (decided 2026-11-24).
 */
function assertListerNoteAllowed(body: TakedownListingDto): void {
  if (body.reasonCode === StaffReasonCode.Guidelines && body.listerNote)
    throw new BadRequestException({ code: 'LISTER_NOTE_NOT_ALLOWED' });
}

const decisionDetails = (body: TakedownListingDto) => ({
  reasonCode: body.reasonCode,
  note: body.note,
  ...(body.listerNote && { listerNote: body.listerNote }),
});

/** The lister's listings in pending_review, live or stale. */
async function activeCount(
  manager: EntityManager,
  listerId: string,
): Promise<number> {
  const [{ n }] = await manager.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE p.lister_id = $1 AND l.status = ANY ($2::listing_status[])`,
    [listerId, ACTIVE_LISTING_STATUSES],
  );
  return n;
}
