import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';
import type { VerificationStatus } from '../users/user.enums.js';
import { ListingHistory } from './listing-history.entity.js';
import { Listing } from './listing.entity.js';
import {
  ActorType,
  ListingHistoryEvent,
  ListingStatus,
} from './listings.enums.js';

// The listing state machine's shared pieces (spec L5, L9): the locks every change takes, the
// groups of states the rules talk about, the history rows, and what a change does to a listing.
// Used by the listing endpoints and by the photo endpoints, so both follow the same rules.

export const listingNotFound = () =>
  new NotFoundException({ code: 'LISTING_NOT_FOUND' });
export const propertyNotFound = () =>
  new NotFoundException({ code: 'PROPERTY_NOT_FOUND' });
export const invalidState = () =>
  new ConflictException({ code: 'INVALID_LISTING_STATE' });

export interface LockedListing {
  id: string;
  status: ListingStatus;
  property_id: string;
  needs_review: boolean;
  published_at: Date | null;
}

/** Where a lister may submit from (L9). */
export const SUBMITTABLE: readonly ListingStatus[] = [
  ListingStatus.Draft,
  ListingStatus.Rejected,
];

/** Where a lister may close from (L9, L12); a draft is deleted instead. */
export const CLOSABLE: readonly ListingStatus[] = [
  ListingStatus.PendingReview,
  ListingStatus.Live,
  ListingStatus.Stale,
  ListingStatus.Expired,
  ListingStatus.Rejected,
];

/** No edits, photos included: relist instead (L5, L11). */
export const CLOSED: readonly ListingStatus[] = [
  ListingStatus.Rented,
  ListingStatus.Removed,
];

/** Live to the public: a change that needs review sends these back to pending_review (L5). */
export const PUBLISHED: readonly ListingStatus[] = [
  ListingStatus.Live,
  ListingStatus.Stale,
];

/** Whose rent and available-from changes go into listing_history (L5, L6). */
export const RECORDED: readonly ListingStatus[] = [
  ...PUBLISHED,
  ListingStatus.Expired,
];

/**
 * Locks the user's row for the rest of the transaction, so the user's draft and active counts
 * can't change underneath a create or a submit (two at once would otherwise both fit under a
 * limit). Returns their verification status as it is now, for L2. Always taken before any
 * listing lock.
 */
export async function lockUser(
  manager: EntityManager,
  userId: string,
): Promise<VerificationStatus> {
  const [row] = await manager.query<
    { verification_status: VerificationStatus }[]
  >(`SELECT verification_status FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  return row.verification_status;
}

const LOCKED_COLUMNS = `l.id, l.status, l.property_id, l.needs_review, l.published_at`;

/**
 * Locks the listing and its property for the rest of the transaction, so two changes at once
 * can't overwrite each other or skip a version. Someone else's listing is 404, the same as a
 * missing one (L3): the ownership check is part of the query, so another user's row is never even
 * loaded.
 */
export async function lockMine(
  manager: EntityManager,
  userId: string,
  id: string,
): Promise<LockedListing> {
  const [row] = await manager.query<LockedListing[]>(
    `SELECT ${LOCKED_COLUMNS}
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE l.id = $1 AND p.lister_id = $2
     FOR UPDATE OF l, p`,
    [id, userId],
  );
  if (!row) throw listingNotFound();
  return row;
}

/**
 * For changes to a property's photos: locks the property and its current listing (the one that
 * isn't rented or removed; L10 and the relist rule leave at most one), the same way as lockMine.
 * Errors: 404 PROPERTY_NOT_FOUND (not yours, or no such property), 409 INVALID_LISTING_STATE (all
 * its listings are closed: relist first).
 */
export async function lockCurrentListingOfProperty(
  manager: EntityManager,
  userId: string,
  propertyId: string,
): Promise<LockedListing> {
  const [row] = await manager.query<LockedListing[]>(
    `SELECT ${LOCKED_COLUMNS}
     FROM listings l JOIN properties p ON p.id = l.property_id
     WHERE p.id = $1 AND p.lister_id = $2 AND l.status <> ALL ($3::listing_status[])
     ORDER BY l.created_at DESC LIMIT 1
     FOR UPDATE OF l, p`,
    [propertyId, userId, CLOSED],
  );
  if (row) return row;
  const [property] = await manager.query<unknown[]>(
    `SELECT 1 FROM properties WHERE id = $1 AND lister_id = $2`,
    [propertyId, userId],
  );
  throw property ? invalidState() : propertyNotFound();
}

/**
 * What a real change does to the listing (L5, L6), with the listing locked: `version` + 1 (R2),
 * plus, for a change that needs review, back to pending_review if it's live or stale (hidden from
 * browse until approved, with a history row) or needs_review if it's expired. `fields` are the
 * listing's own changed columns, written in the same statement. Returns whether it went back to
 * review.
 */
export async function applyChangeEffects(
  manager: EntityManager,
  locked: LockedListing,
  userId: string,
  {
    needsReview,
    fields = {},
  }: { needsReview: boolean; fields?: Partial<Listing> },
): Promise<boolean> {
  const backToReview = needsReview && PUBLISHED.includes(locked.status);
  await manager.update(Listing, locked.id, {
    ...fields,
    version: () => 'version + 1',
    ...(backToReview && {
      status: ListingStatus.PendingReview,
      submittedAt: () => 'now()',
    }),
    ...(needsReview &&
      locked.status === ListingStatus.Expired && { needsReview: true }),
  });
  if (backToReview)
    await recordStatusChange(
      manager,
      locked.id,
      locked.status,
      ListingStatus.PendingReview,
      userId,
    );
  return backToReview;
}

/** A status row in listing_history, in the caller's transaction (overview §6). */
export async function recordStatusChange(
  manager: EntityManager,
  listingId: string,
  oldStatus: ListingStatus | null,
  newStatus: ListingStatus,
  userId: string,
  reason: Pick<Partial<ListingHistory>, 'closeReason'> = {},
): Promise<void> {
  await manager.insert(ListingHistory, {
    listingId,
    event: ListingHistoryEvent.Status,
    oldStatus,
    newStatus,
    ...reason,
    actorType: ActorType.User,
    actorId: userId,
  });
}

/** A rent or available-from row in listing_history, in the caller's transaction (L5). */
export async function recordValueChange(
  manager: EntityManager,
  listingId: string,
  userId: string,
  change: Pick<
    Partial<ListingHistory>,
    | 'event'
    | 'oldMonthlyRentBirr'
    | 'newMonthlyRentBirr'
    | 'oldAvailableFrom'
    | 'newAvailableFrom'
  >,
): Promise<void> {
  await manager.insert(ListingHistory, {
    listingId,
    ...change,
    actorType: ActorType.User,
    actorId: userId,
  });
}

/** A unique or check violation of the named constraint (Postgres reports it by name). */
export function violates(error: unknown, constraint: string): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { constraint?: string }).constraint === constraint
  );
}
