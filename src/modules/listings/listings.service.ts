import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, type Point } from 'typeorm';
import { ADDIS_ABABA_TIME_ZONE, todayIn } from '../../common/dates.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { ServiceAreaService } from '../areas/service-area.service.js';
import { VerificationStatus } from '../users/user.enums.js';
import { randomOffset } from './approx-location.js';
import type {
  LatLngDto,
  ListingFieldsDto,
  MyListingDto,
} from './dto/listing.dto.js';
import { assertWithinLimits } from './listing-limits.js';
import { missingFields } from './listing-completeness.js';
import { ListingHistory } from './listing-history.entity.js';
import { Listing } from './listing.entity.js';
import {
  ACTIVE_LISTING_STATUSES,
  ActorType,
  Amenity,
  ListingHistoryEvent,
  ListingStatus,
} from './listings.enums.js';
import { MIN_PHOTOS_TO_SUBMIT, PhotoCounter } from './photo-counter.js';
import { Property } from './property.entity.js';

export const listingNotFound = () =>
  new NotFoundException({ code: 'LISTING_NOT_FOUND' });
const invalidState = () =>
  new ConflictException({ code: 'INVALID_LISTING_STATE' });

/** Body fields stored on the property (the location is handled on its own) and on the listing. */
const PROPERTY_FIELDS = [
  'neighbourhoodId',
  'unlistedNeighbourhoodName',
  'type',
  'bedrooms',
  'bathrooms',
  'furnished',
  'separateWaterMeter',
  'separateElectricityMeter',
  'sizeM2',
  'floor',
  'amenities',
  'description',
  'landmark',
  'listerRelation',
] as const satisfies readonly (keyof ListingFieldsDto & keyof Property)[];
const LISTING_FIELDS = [
  'monthlyRentBirr',
  'advanceMonths',
  'negotiable',
  'availableFrom',
] as const satisfies readonly (keyof ListingFieldsDto & keyof Listing)[];

// GeoJSON from PostGIS has 9 decimals; closer than this (about 0.1 mm) is the same point.
const SAME_POINT_DEGREES = 1e-8;

const AMENITY_ORDER = Object.values(Amenity);

interface LockedListing {
  id: string;
  status: ListingStatus;
  property_id: string;
}

/** Where a lister may submit from (L9). */
const SUBMITTABLE: readonly ListingStatus[] = [
  ListingStatus.Draft,
  ListingStatus.Rejected,
];

/**
 * The lister's side of listings (spec section 3): drafts (T2.2), submit and withdraw (T2.3).
 * Editing in other states, closing and relisting come in T2.4–T2.5.
 */
@Injectable()
export class ListingsService {
  private readonly maxDrafts: number;
  private readonly maxActive: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly serviceArea: ServiceAreaService,
    private readonly photos: PhotoCounter,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxDrafts = config.get('MAX_DRAFT_LISTINGS', { infer: true });
    this.maxActive = config.get('LISTING_MAX_ACTIVE_PER_USER', { infer: true });
  }

  /** Every listing of the user, in any state, newest first. */
  async listMine(userId: string): Promise<MyListingDto[]> {
    const listings = await this.mine(this.dataSource.manager, userId).getMany();
    return listings.map(toMyListing);
  }

  /**
   * L1: any signed-in, active user; no verification needed. A new property with its first
   * listing, as a draft, with its history row.
   * Errors: 400 limits / AVAILABLE_FROM_IN_PAST / LOCATION_OUTSIDE_SERVICE_AREA /
   * NEIGHBOURHOOD_NOT_FOUND / NEIGHBOURHOOD_INACTIVE, 409 DRAFT_LISTING_LIMIT.
   */
  async create(userId: string, body: ListingFieldsDto): Promise<MyListingDto> {
    assertWithinLimits(body);
    if (body.availableFrom) assertNotPast(body.availableFrom);
    if (body.location) await this.requireInside(body.location);

    const id = await this.dataSource.transaction(async (manager) => {
      // One create at a time per user, so two at once can't both slip under the draft limit.
      await lockUser(manager, userId);
      const [{ drafts }] = await manager.query<{ drafts: number }[]>(
        `SELECT count(*)::int AS drafts
         FROM listings l JOIN properties p ON p.id = l.property_id
         WHERE p.lister_id = $1 AND l.status = 'draft'`,
        [userId],
      );
      if (drafts >= this.maxDrafts)
        throw new ConflictException({
          code: 'DRAFT_LISTING_LIMIT',
          max: this.maxDrafts,
        });
      if (body.neighbourhoodId)
        await assertPickable(manager, body.neighbourhoodId);

      const property = await manager.insert(Property, {
        listerId: userId,
        ...changes({}, body, PROPERTY_FIELDS),
      });
      const propertyId = property.identifiers[0].id as string;
      if (body.location) await setLocation(manager, propertyId, body.location);

      const listing = await manager.insert(Listing, {
        propertyId,
        ...changes({}, body, LISTING_FIELDS),
      });
      const listingId = listing.identifiers[0].id as string;
      await recordStatusChange(
        manager,
        listingId,
        null,
        ListingStatus.Draft,
        userId,
      );
      return listingId;
    });
    return this.getMine(userId, id);
  }

  /**
   * Edits a draft (L5; other states from T2.4). A missing field is kept, null clears it. Only
   * real changes count: they add 1 to `version`; the same values again change nothing.
   * Errors: as create, plus 400 NO_FIELDS_TO_UPDATE, 404 LISTING_NOT_FOUND (L3), 409
   * INVALID_LISTING_STATE.
   */
  async update(
    userId: string,
    id: string,
    body: ListingFieldsDto,
  ): Promise<MyListingDto> {
    if (Object.values(body).every((value) => value === undefined))
      throw new BadRequestException({ code: 'NO_FIELDS_TO_UPDATE' });
    assertWithinLimits(body);
    if (body.location) await this.requireInside(body.location);

    await this.dataSource.transaction(async (manager) => {
      const locked = await lockMine(manager, userId, id);
      if (locked.status !== ListingStatus.Draft) throw invalidState();

      const property = await manager
        .createQueryBuilder(Property, 'p')
        .addSelect(['p.location', 'p.landmark'])
        .where('p.id = :id', { id: locked.property_id })
        .getOneOrFail();
      const listing = await manager.findOneByOrFail(Listing, { id });

      const propertyChanges = changes(property, body, PROPERTY_FIELDS);
      const listingChanges = changes(listing, body, LISTING_FIELDS);
      const locationChanged =
        body.location !== undefined &&
        !samePoint(property.location, body.location);

      // Checked only when changed: a property keeps a neighbourhood staff deactivated later (G8),
      // and an old available-from date doesn't block other edits (L13: "when set or changed").
      if (propertyChanges.neighbourhoodId)
        await assertPickable(manager, propertyChanges.neighbourhoodId);
      if (listingChanges.availableFrom)
        assertNotPast(listingChanges.availableFrom);

      const changed =
        Object.keys(propertyChanges).length > 0 ||
        Object.keys(listingChanges).length > 0 ||
        locationChanged;
      if (!changed) return;

      if (Object.keys(propertyChanges).length > 0)
        await manager.update(Property, property.id, propertyChanges);
      if (locationChanged)
        await setLocation(manager, property.id, body.location ?? null);
      await manager.update(Listing, id, {
        ...listingChanges,
        version: () => 'version + 1',
      });
    });
    return this.getMine(userId, id);
  }

  /**
   * Deletes a draft with its history; a draft was never reviewed, so nothing is kept. The
   * property goes too unless older listings of it remain (a relist draft, L11).
   * Errors: 404 LISTING_NOT_FOUND (L3), 409 INVALID_LISTING_STATE.
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await lockMine(manager, userId, id);
      if (locked.status !== ListingStatus.Draft) throw invalidState();

      await manager.delete(Listing, id);
      const [{ others }] = await manager.query<{ others: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM listings WHERE property_id = $1) AS others`,
        [locked.property_id],
      );
      if (!others) await manager.delete(Property, locked.property_id);
    });
  }

  /**
   * Sends a draft or a rejected listing to staff review (L2, L4): `pending_review`, hidden from
   * browse until approved. Every listing goes through review before it first goes live, including
   * resubmitted rejected ones, and this is the only way out of `draft` and `rejected` towards live.
   * An available-from date that has passed meanwhile is allowed (decided 2026-11-23: L13 checks it
   * only when set or changed; the app shows a past date as "Available now").
   * Errors: 403 VERIFICATION_REQUIRED, 400 LISTING_INCOMPLETE / NOT_ENOUGH_PHOTOS, 404
   * LISTING_NOT_FOUND (L3), 409 INVALID_LISTING_STATE / ACTIVE_LISTING_LIMIT.
   */
  async submit(userId: string, id: string): Promise<MyListingDto> {
    await this.dataSource.transaction(async (manager) => {
      // The user first, then the listing: the same order as every other path that takes both.
      const verification = await lockUser(manager, userId);
      const locked = await lockMine(manager, userId, id);
      if (!SUBMITTABLE.includes(locked.status)) throw invalidState();

      await this.assertCanBecomeActive(manager, userId, verification, locked);
      await manager.update(Listing, id, {
        status: ListingStatus.PendingReview,
        submittedAt: () => 'now()',
      });
      await recordStatusChange(
        manager,
        id,
        locked.status,
        ListingStatus.PendingReview,
        userId,
      );
    });
    return this.getMine(userId, id);
  }

  /**
   * Takes a listing back out of review, to fix something before staff look at it (L9). Allowed
   * even at the draft limit (decided 2026-11-23): the limit is about creating drafts, and refusing
   * would trap the listing in review.
   * Errors: 404 LISTING_NOT_FOUND (L3), 409 INVALID_LISTING_STATE (not in review).
   */
  async withdraw(userId: string, id: string): Promise<MyListingDto> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await lockMine(manager, userId, id);
      if (locked.status !== ListingStatus.PendingReview) throw invalidState();

      await manager.update(Listing, id, { status: ListingStatus.Draft });
      await recordStatusChange(
        manager,
        id,
        ListingStatus.PendingReview,
        ListingStatus.Draft,
        userId,
      );
    });
    return this.getMine(userId, id);
  }

  /**
   * L2: what a listing needs to move into an active state from a non-active one. Submitting uses
   * it now; reopening an expired listing (L6, T2.4) will too. Checked in this order, inside the
   * caller's transaction with the user and the listing locked, so the answer can't go stale before
   * the move: verified, complete, enough photos, under the active cap.
   */
  private async assertCanBecomeActive(
    manager: EntityManager,
    userId: string,
    verification: VerificationStatus,
    locked: LockedListing,
  ): Promise<void> {
    if (verification !== VerificationStatus.Approved)
      throw new ForbiddenException({ code: 'VERIFICATION_REQUIRED' });

    const listing = await this.mine(manager, userId)
      .andWhere('l.id = :id', { id: locked.id })
      .getOneOrFail();
    const missing = missingFields(listing, listing.property!);
    if (missing.length > 0)
      throw new BadRequestException({ code: 'LISTING_INCOMPLETE', missing });

    if (
      (await this.photos.count(manager, locked.property_id)) <
      MIN_PHOTOS_TO_SUBMIT
    )
      throw new BadRequestException({
        code: 'NOT_ENOUGH_PHOTOS',
        min: MIN_PHOTOS_TO_SUBMIT,
      });

    const [{ active }] = await manager.query<{ active: number }[]>(
      `SELECT count(*)::int AS active
       FROM listings l JOIN properties p ON p.id = l.property_id
       WHERE p.lister_id = $1 AND l.status = ANY ($2::listing_status[])`,
      [userId, ACTIVE_LISTING_STATUSES],
    );
    if (active >= this.maxActive)
      throw new ConflictException({
        code: 'ACTIVE_LISTING_LIMIT',
        max: this.maxActive,
      });
  }

  private async getMine(userId: string, id: string): Promise<MyListingDto> {
    const listing = await this.mine(this.dataSource.manager, userId)
      .andWhere('l.id = :id', { id })
      .getOne();
    if (!listing) throw listingNotFound();
    return toMyListing(listing);
  }

  /** The user's own listings with their property, including its private fields (G3). */
  private mine(manager: EntityManager, userId: string) {
    return manager
      .createQueryBuilder(Listing, 'l')
      .innerJoinAndSelect('l.property', 'p')
      .addSelect(['p.location', 'p.landmark'])
      .leftJoinAndSelect('p.neighbourhood', 'n')
      .leftJoinAndSelect('n.subCity', 's')
      .where('p.listerId = :userId', { userId })
      .orderBy('l.createdAt', 'DESC')
      .addOrderBy('l.id', 'DESC');
  }

  private requireInside(location: LatLngDto): Promise<void> {
    return this.serviceArea.requireInside(location.lat, location.lng);
  }
}

/**
 * Locks the user's row for the rest of the transaction, so the user's draft and active counts
 * can't change underneath a create or a submit (two at once would otherwise both fit under a
 * limit). Returns their verification status as it is now, for L2.
 */
async function lockUser(
  manager: EntityManager,
  userId: string,
): Promise<VerificationStatus> {
  const [row] = await manager.query<
    { verification_status: VerificationStatus }[]
  >(`SELECT verification_status FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  return row.verification_status;
}

/** A status row in listing_history, in the caller's transaction (overview §6). */
async function recordStatusChange(
  manager: EntityManager,
  listingId: string,
  oldStatus: ListingStatus | null,
  newStatus: ListingStatus,
  userId: string,
): Promise<void> {
  await manager.insert(ListingHistory, {
    listingId,
    event: ListingHistoryEvent.Status,
    oldStatus,
    newStatus,
    actorType: ActorType.User,
    actorId: userId,
  });
}

/**
 * Locks the listing and its property for the rest of the transaction, so two edits at once can't
 * overwrite each other or skip a version. Someone else's listing is 404, the same as a missing one
 * (L3): the ownership check is part of the query, so another user's row is never even loaded.
 */
async function lockMine(
  manager: EntityManager,
  userId: string,
  id: string,
): Promise<LockedListing> {
  const [row] = await manager.query<LockedListing[]>(
    `SELECT l.id, l.status, l.property_id
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.id = $1 AND p.lister_id = $2
     FOR UPDATE OF l, p`,
    [id, userId],
  );
  if (!row) throw listingNotFound();
  return row;
}

/** A neighbourhood that may be newly picked: it exists and staff haven't deactivated it (G8). */
async function assertPickable(
  manager: EntityManager,
  neighbourhoodId: string,
): Promise<void> {
  const [row] = await manager.query<{ active: boolean }[]>(
    `SELECT deactivated_at IS NULL AS active FROM neighbourhoods WHERE id = $1`,
    [neighbourhoodId],
  );
  if (!row) throw new BadRequestException({ code: 'NEIGHBOURHOOD_NOT_FOUND' });
  if (!row.active)
    throw new BadRequestException({ code: 'NEIGHBOURHOOD_INACTIVE' });
}

/** L13: not before today in Addis Ababa. */
function assertNotPast(date: string): void {
  if (date < todayIn(ADDIS_ABABA_TIME_ZONE))
    throw new BadRequestException({ code: 'AVAILABLE_FROM_IN_PAST' });
}

/**
 * Sets the exact point and makes a new approximate one 200–400 m away (G2), in one statement so
 * the "both or neither" check holds; null clears both. Only called when the point really changes.
 * The casts pick ST_Project(geography, distance, azimuth): PostGIS 3.4 added a second ST_Project.
 */
async function setLocation(
  manager: EntityManager,
  propertyId: string,
  location: LatLngDto | null,
): Promise<void> {
  if (location === null) {
    await manager.query(
      `UPDATE properties SET location = NULL, approx_location = NULL, updated_at = now()
       WHERE id = $1`,
      [propertyId],
    );
    return;
  }
  const { distanceMetres, azimuthRadians } = randomOffset();
  await manager.query(
    `UPDATE properties
     SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
         approx_location = ST_Project(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4::float8, $5::float8),
         updated_at = now()
     WHERE id = $1`,
    [propertyId, location.lng, location.lat, distanceMetres, azimuthRadians],
  );
}

/**
 * The body's values for `fields` that differ from `current` (undefined = not sent, skipped).
 * Amenities are compared and stored in one fixed order, so ["guard", "parking"] equals
 * ["parking", "guard"].
 */
function changes<
  K extends (typeof PROPERTY_FIELDS | typeof LISTING_FIELDS)[number],
>(
  current: Partial<Record<K, unknown>>,
  body: ListingFieldsDto,
  fields: readonly K[],
): Partial<Pick<ListingFieldsDto, K>> {
  const result: Partial<Record<K, unknown>> = {};
  for (const field of fields) {
    let next: unknown = body[field];
    if (next === undefined) continue;
    if (field === 'amenities')
      next = [...(next as Amenity[])].sort(
        (a, b) => AMENITY_ORDER.indexOf(a) - AMENITY_ORDER.indexOf(b),
      );
    const before = current[field];
    const same = Array.isArray(next)
      ? Array.isArray(before) && next.join() === before.join()
      : next === before;
    if (!same) result[field] = next;
  }
  return result as Partial<Pick<ListingFieldsDto, K>>;
}

function samePoint(current: Point | null, next: LatLngDto | null): boolean {
  if (current === null || next === null) return current === next;
  const [lng, lat] = current.coordinates;
  return (
    Math.abs(lat - next.lat) < SAME_POINT_DEGREES &&
    Math.abs(lng - next.lng) < SAME_POINT_DEGREES
  );
}

const toLatLng = (point: Point | null) =>
  point ? { lat: point.coordinates[1], lng: point.coordinates[0] } : null;

function toMyListing(listing: Listing): MyListingDto {
  const property = listing.property!;
  const neighbourhood = property.neighbourhood ?? null;
  const subCity = neighbourhood?.subCity ?? null;
  return {
    id: listing.id,
    status: listing.status,
    version: listing.version,
    missing: missingFields(listing, property),
    monthlyRentBirr: listing.monthlyRentBirr,
    advanceMonths: listing.advanceMonths,
    negotiable: listing.negotiable,
    availableFrom: listing.availableFrom,
    closeReason: listing.closeReason,
    staffReasonCode: listing.staffReasonCode,
    listerNote: listing.listerNote,
    property: {
      id: property.id,
      neighbourhood: neighbourhood && {
        id: neighbourhood.id,
        nameEn: neighbourhood.nameEn,
        nameAm: neighbourhood.nameAm,
        active: neighbourhood.deactivatedAt === null,
      },
      subCity: subCity && {
        id: subCity.id,
        nameEn: subCity.nameEn,
        nameAm: subCity.nameAm,
      },
      unlistedNeighbourhoodName: property.unlistedNeighbourhoodName,
      type: property.type,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      furnished: property.furnished,
      separateWaterMeter: property.separateWaterMeter,
      separateElectricityMeter: property.separateElectricityMeter,
      sizeM2: property.sizeM2,
      floor: property.floor,
      amenities: property.amenities,
      description: property.description,
      location: toLatLng(property.location),
      approxLocation: toLatLng(property.approxLocation),
      landmark: property.landmark,
      listerRelation: property.listerRelation,
    },
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    submittedAt: listing.submittedAt,
    publishedAt: listing.publishedAt,
    closedAt: listing.closedAt,
  };
}
