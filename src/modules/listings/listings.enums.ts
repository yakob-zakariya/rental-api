/** Residential only (spec section 2, P2-2). */
export enum PropertyType {
  Condominium = 'condominium',
  Apartment = 'apartment',
  VillaHouse = 'villa_house',
  CompoundRoom = 'compound_room',
  Studio = 'studio',
}

/** The fixed amenity list (P2-2). */
export enum Amenity {
  Parking = 'parking',
  GatedCompound = 'gated_compound',
  Guard = 'guard',
}

/** Shown on the listing (overview §4). */
export enum ListerRelation {
  Owner = 'owner',
  Representative = 'representative',
}

/** The listing state machine (spec L9). */
export enum ListingStatus {
  Draft = 'draft',
  PendingReview = 'pending_review',
  Live = 'live',
  Stale = 'stale',
  Expired = 'expired',
  Rented = 'rented',
  Removed = 'removed',
  Rejected = 'rejected',
}

/** "Active" counts toward the listing cap and the reviewer flag (L2, R1, P2-1). */
export const ACTIVE_LISTING_STATUSES: readonly ListingStatus[] = [
  ListingStatus.PendingReview,
  ListingStatus.Live,
  ListingStatus.Stale,
];

/** "Open": at most one per property (L10). */
export const OPEN_LISTING_STATUSES: readonly ListingStatus[] = [
  ListingStatus.Draft,
  ...ACTIVE_LISTING_STATUSES,
  ListingStatus.Expired,
];

/** Why a listing was closed (L12, R5). */
export enum CloseReason {
  RentedInApp = 'rented_in_app',
  RentedElsewhere = 'rented_elsewhere',
  NoLongerForRent = 'no_longer_for_rent',
  StaffTakedown = 'staff_takedown',
}

/** A rejection or takedown reason, sent to the lister (R4, R5). */
export enum StaffReasonCode {
  PhotosUnclear = 'PHOTOS_UNCLEAR',
  PhotosDontMatch = 'PHOTOS_DONT_MATCH',
  WrongLocation = 'WRONG_LOCATION',
  MissingInformation = 'MISSING_INFORMATION',
  DuplicateListing = 'DUPLICATE_LISTING',
  /** "Didn't meet our guidelines": also the neutral reason for suspected fraud (P2-12). */
  Guidelines = 'GUIDELINES',
}

/** What a listing_history row records. */
export enum ListingHistoryEvent {
  Status = 'status',
  MonthlyRent = 'monthly_rent',
  AvailableFrom = 'available_from',
}

/** Who made a change. `system` is a scheduled job and has no id. */
export enum ActorType {
  User = 'user',
  Admin = 'admin',
  System = 'system',
}
