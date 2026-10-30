export enum UserLanguage {
  Amharic = 'am',
  AfaanOromo = 'om',
  English = 'en',
}

export enum UserStatus {
  Active = 'active',
  // Not set by anything in Phase 1; comes with moderation later.
  Suspended = 'suspended',
  Banned = 'banned',
}

export enum VerificationStatus {
  NotVerified = 'not_verified',
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  ManualReview = 'manual_review',
  Blocked = 'blocked',
}
