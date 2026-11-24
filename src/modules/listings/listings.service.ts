import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In, type Point } from 'typeorm';
import { ADDIS_ABABA_TIME_ZONE, todayIn } from '../../common/dates.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { ServiceAreaService } from '../areas/service-area.service.js';
import { PhotoStorage } from '../photos/photo-storage.js';
import { PropertyPhoto } from '../photos/property-photo.entity.js';
import { VerificationStatus } from '../users/user.enums.js';
import { randomOffset } from './approx-location.js';
import type {
  LatLngDto,
  ListingFieldsDto,
  MyListingDto,
  PhotoDto,
} from './dto/listing.dto.js';
import { assertWithinLimits } from './listing-limits.js';
import { missingFields } from './listing-completeness.js';
import {
  applyChangeEffects,
  CLOSABLE,
  CLOSED,
  invalidState,
  listingNotFound,
  type LockedListing,
  lockMine,
  lockUser,
  propertyNotFound,
  RECORDED,
  recordStatusChange,
  recordValueChange,
  SUBMITTABLE,
  violates,
} from './listing-state.js';
import { Listing } from './listing.entity.js';
import {
  ACTIVE_LISTING_STATUSES,
  Amenity,
  CloseReason,
  type ListerCloseReason,
  ListingHistoryEvent,
  ListingStatus,
  OPEN_LISTING_STATUSES,
} from './listings.enums.js';
import { MIN_PHOTOS_TO_SUBMIT, PhotoCounter } from './photo-counter.js';
import { Property } from './property.entity.js';

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

/**
 * The fields a live listing changes without going back to review (L5). Every other field,
 * including the location and the photos (reordering aside), needs review.
 */
const APPLY_AT_ONCE = [
  'monthlyRentBirr',
  'availableFrom',
  'negotiable',
] as const;
type ApplyAtOnceField = (typeof APPLY_AT_ONCE)[number];

/**
 * The lister's side of listings (spec section 3): drafts (T2.2), submit and withdraw (T2.3),
 * editing in every state and reopening (T2.4), closing and relisting (T2.5). Photos are in
 * PropertyPhotosService (T3.2).
 */
@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);
  private readonly maxDrafts: number;
  private readonly maxActive: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly serviceArea: ServiceAreaService,
    private readonly photos: PhotoCounter,
    private readonly storage: PhotoStorage,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxDrafts = config.get('MAX_DRAFT_LISTINGS', { infer: true });
    this.maxActive = config.get('LISTING_MAX_ACTIVE_PER_USER', { infer: true });
  }

  /** Every listing of the user, in any state, newest first. */
  async listMine(userId: string): Promise<MyListingDto[]> {
    const listings = await this.mine(this.dataSource.manager, userId).getMany();
    return this.withPhotos(listings);
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
      await this.assertUnderDraftLimit(manager, userId);
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
   * Edits a listing (L5, L6). A missing field is kept, null clears it; only real changes count,
   * and each adds 1 to `version`. What an edit does depends on the state:
   * - draft, rejected, pending_review: applies (pending_review stays in the queue; the new version
   *   makes a reviewer's decision on the old one fail, R2);
   * - live, stale: rent, available-from and negotiable apply at once; any other field sends the
   *   listing back to pending_review, hidden from browse until approved;
   * - expired: applies; a field that needs review sets needs_review, for reopening (L6);
   * - rented, removed: refused (relist instead, L11).
   * Rent and available-from changes of a live, stale or expired listing go into listing_history.
   * Outside draft, a change can't empty a required field (decided 2026-11-24).
   * Errors: as create, plus 400 NO_FIELDS_TO_UPDATE / LISTING_INCOMPLETE, 404 LISTING_NOT_FOUND
   * (L3), 409 INVALID_LISTING_STATE.
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
      if (CLOSED.includes(locked.status)) throw invalidState();

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

      // Drafts may be half-filled; past draft a listing stays complete (Q1, 2026-11-24). The
      // check runs on plain copies with the changes applied (entities are plain data).
      if (locked.status !== ListingStatus.Draft) {
        const missing = missingFields(
          Object.assign({}, listing, listingChanges),
          Object.assign({}, property, propertyChanges, {
            location: locationChanged
              ? toPoint(body.location ?? null)
              : property.location,
          }),
        );
        if (missing.length > 0)
          throw new BadRequestException({
            code: 'LISTING_INCOMPLETE',
            missing,
          });
      }

      const needsReview =
        Object.keys(propertyChanges).length > 0 ||
        locationChanged ||
        Object.keys(listingChanges).some(
          (field) => !APPLY_AT_ONCE.includes(field as ApplyAtOnceField),
        );

      if (Object.keys(propertyChanges).length > 0)
        await manager.update(Property, property.id, propertyChanges);
      if (locationChanged)
        await setLocation(manager, property.id, body.location ?? null);
      await applyChangeEffects(manager, locked, userId, {
        needsReview,
        fields: listingChanges as Partial<Listing>,
      });

      // History: what the public saw change (overview §6).
      if (RECORDED.includes(locked.status)) {
        if (listingChanges.monthlyRentBirr !== undefined)
          await recordValueChange(manager, id, userId, {
            event: ListingHistoryEvent.MonthlyRent,
            oldMonthlyRentBirr: listing.monthlyRentBirr,
            newMonthlyRentBirr: listingChanges.monthlyRentBirr,
          });
        if (listingChanges.availableFrom !== undefined)
          await recordValueChange(manager, id, userId, {
            event: ListingHistoryEvent.AvailableFrom,
            oldAvailableFrom: listing.availableFrom,
            newAvailableFrom: listingChanges.availableFrom,
          });
      }
    });
    return this.getMine(userId, id);
  }

  /**
   * Deletes a draft with its history; a draft was never reviewed, so nothing is kept. The
   * property goes too, with its photos (rows and files), unless older listings of it remain (a
   * relist draft, L11: the photos stay with the property).
   * Errors: 404 LISTING_NOT_FOUND (L3), 409 INVALID_LISTING_STATE.
   */
  async remove(userId: string, id: string): Promise<void> {
    const deletedKeys = await this.dataSource.transaction(async (manager) => {
      const locked = await lockMine(manager, userId, id);
      if (locked.status !== ListingStatus.Draft) throw invalidState();

      await manager.delete(Listing, id);
      const [{ others }] = await manager.query<{ others: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM listings WHERE property_id = $1) AS others`,
        [locked.property_id],
      );
      if (others) return [];
      const photos = await manager.findBy(PropertyPhoto, {
        propertyId: locked.property_id,
      });
      await manager.delete(PropertyPhoto, { propertyId: locked.property_id });
      await manager.delete(Property, locked.property_id);
      return photos.map((photo) => photo.storageKey);
    });
    // After the commit: if the transaction had failed, the files would still be needed.
    await this.deleteFiles(deletedKeys);
  }

  /**
   * Deletes photo files from storage, after the rows are gone. Best effort: a failure leaves an
   * orphaned file (logged), never a photo row pointing at nothing.
   */
  async deleteFiles(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.deletePrivate(key);
        await this.storage.unpublish(key);
      } catch (error) {
        this.logger.warn(
          `Could not delete photo file ${key}: ${(error as Error).message}`,
        );
      }
    }
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
   * Reopens an expired listing by confirming its details (L6): back to live, or to review if it
   * was changed in a way that needs review (needs_review) or was never approved (published_at
   * empty; decided 2026-11-24, so L4 holds for a listing that expired while in review). Checks L2
   * like submitting, counts as a confirmation (last_confirmed_at, restarting the weekly checks),
   * and keeps the original published_at, so it doesn't jump to the top of "newest" (decided
   * 2026-11-24).
   * Errors: as submit; 409 INVALID_LISTING_STATE if it isn't expired.
   */
  async reopen(userId: string, id: string): Promise<MyListingDto> {
    await this.dataSource.transaction(async (manager) => {
      const verification = await lockUser(manager, userId);
      const locked = await lockMine(manager, userId, id);
      if (locked.status !== ListingStatus.Expired) throw invalidState();

      await this.assertCanBecomeActive(manager, userId, verification, locked);
      const toReview = locked.needs_review || locked.published_at === null;
      const status = toReview
        ? ListingStatus.PendingReview
        : ListingStatus.Live;
      await manager.update(Listing, id, {
        status,
        needsReview: false,
        lastConfirmedAt: () => 'now()',
        ...(toReview && { submittedAt: () => 'now()' }),
      });
      await recordStatusChange(
        manager,
        id,
        ListingStatus.Expired,
        status,
        userId,
      );
    });
    return this.getMine(userId, id);
  }

  /**
   * Closes a listing with one of the lister's reasons (L12): rented_in_app or rented_elsewhere →
   * rented, no_longer_for_rent → removed. Allowed from pending_review, live, stale, expired and
   * rejected (a draft is deleted instead). "Rented in the app" needs a listing that was published
   * at some point (decided 2026-11-24): one nobody saw can't have been rented through the app, and
   * that number must be trustworthy. It doesn't pick the tenant yet (Phase 3).
   * Errors: 400 RENTED_IN_APP_NEVER_PUBLISHED, 404 LISTING_NOT_FOUND (L3), 409
   * INVALID_LISTING_STATE.
   */
  async close(
    userId: string,
    id: string,
    reason: ListerCloseReason,
  ): Promise<MyListingDto> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await lockMine(manager, userId, id);
      if (!CLOSABLE.includes(locked.status)) throw invalidState();
      if (reason === CloseReason.RentedInApp && locked.published_at === null)
        throw new BadRequestException({
          code: 'RENTED_IN_APP_NEVER_PUBLISHED',
        });

      const status =
        reason === CloseReason.NoLongerForRent
          ? ListingStatus.Removed
          : ListingStatus.Rented;
      await manager.update(Listing, id, {
        status,
        closeReason: reason,
        closedAt: () => 'now()',
      });
      await recordStatusChange(manager, id, locked.status, status, userId, {
        closeReason: reason,
      });
    });
    return this.getMine(userId, id);
  }

  /**
   * Relists a property (L11): a new draft on it, after its listings are all rented or removed, so
   * the history is kept. Copies rent, advance months and negotiable from the latest closed
   * listing, and available-from only if it's today or later (decided 2026-11-24); the property's
   * own fields are shared. A rejected listing blocks relisting like an open one (decided
   * 2026-11-24): fix and resubmit it, or close it, first.
   * Errors: 404 PROPERTY_NOT_FOUND (L3), 409 PROPERTY_HAS_OPEN_LISTING (with `listingId`, L10) /
   * DRAFT_LISTING_LIMIT.
   */
  async relist(userId: string, propertyId: string): Promise<MyListingDto> {
    const id = await this.dataSource.transaction(async (manager) => {
      await lockUser(manager, userId);
      // Locked, so two relists at once run one after the other and the second sees the first.
      const [property] = await manager.query<{ id: string }[]>(
        `SELECT id FROM properties WHERE id = $1 AND lister_id = $2 FOR UPDATE`,
        [propertyId, userId],
      );
      if (!property) throw propertyNotFound();

      const [blocking] = await manager.query<{ id: string }[]>(
        `SELECT id FROM listings
         WHERE property_id = $1 AND status = ANY ($2::listing_status[])
         ORDER BY created_at DESC LIMIT 1`,
        [propertyId, [...OPEN_LISTING_STATUSES, ListingStatus.Rejected]],
      );
      if (blocking)
        throw new ConflictException({
          code: 'PROPERTY_HAS_OPEN_LISTING',
          listingId: blocking.id,
        });
      await this.assertUnderDraftLimit(manager, userId);

      const previous = await manager.findOne(Listing, {
        where: { propertyId },
        order: { closedAt: 'DESC', createdAt: 'DESC' },
      });
      const today = todayIn(ADDIS_ABABA_TIME_ZONE);
      const insert = manager.insert(Listing, {
        propertyId,
        monthlyRentBirr: previous?.monthlyRentBirr ?? null,
        advanceMonths: previous?.advanceMonths ?? null,
        negotiable: previous?.negotiable ?? null,
        availableFrom:
          previous?.availableFrom && previous.availableFrom >= today
            ? previous.availableFrom
            : null,
      });
      // The lock above already orders relists; the index (L10) is the last word if anything slips.
      const { identifiers } = await insert.catch((error: unknown) => {
        if (violates(error, 'UQ_listings_one_open_per_property'))
          throw new ConflictException({ code: 'PROPERTY_HAS_OPEN_LISTING' });
        throw error;
      });
      const listingId = identifiers[0].id as string;
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

  /** L1: at most MAX_DRAFT_LISTINGS drafts at once. The caller holds the user lock. */
  private async assertUnderDraftLimit(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
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

  /** One of the user's own listings, as they see it (404 if it isn't theirs). */
  async getMine(userId: string, id: string): Promise<MyListingDto> {
    const listing = await this.mine(this.dataSource.manager, userId)
      .andWhere('l.id = :id', { id })
      .getOne();
    if (!listing) throw listingNotFound();
    const [view] = await this.withPhotos([listing]);
    return view;
  }

  /** The lister's view, with each property's photos in order, as short-lived signed links (P5). */
  private async withPhotos(listings: Listing[]): Promise<MyListingDto[]> {
    const propertyIds = [...new Set(listings.map((l) => l.propertyId))];
    const photos =
      propertyIds.length === 0
        ? []
        : await this.dataSource.manager.find(PropertyPhoto, {
            where: { propertyId: In(propertyIds) },
            order: { position: 'ASC' },
          });
    const views = new Map<string, PhotoDto[]>();
    for (const photo of photos) {
      const list = views.get(photo.propertyId) ?? [];
      list.push({
        id: photo.id,
        position: photo.position,
        width: photo.width,
        height: photo.height,
        url: await this.storage.signedUrl(photo.storageKey),
      });
      views.set(photo.propertyId, list);
    }
    return listings.map((listing) =>
      toMyListing(listing, views.get(listing.propertyId) ?? []),
    );
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

const toPoint = (location: LatLngDto | null): Point | null =>
  location && { type: 'Point', coordinates: [location.lng, location.lat] };

const toLatLng = (point: Point | null) =>
  point ? { lat: point.coordinates[1], lng: point.coordinates[0] } : null;

function toMyListing(listing: Listing, photos: PhotoDto[]): MyListingDto {
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
    needsReview: listing.needsReview,
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
      photos,
    },
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    submittedAt: listing.submittedAt,
    publishedAt: listing.publishedAt,
    closedAt: listing.closedAt,
  };
}
