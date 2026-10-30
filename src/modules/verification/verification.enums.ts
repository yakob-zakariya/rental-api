/** Our decision for one verification attempt. "Final" means anything other than `pending`. */
export enum VerificationOutcome {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  ManualReview = 'manual_review',
  Blocked = 'blocked',
  Abandoned = 'abandoned',
  Expired = 'expired',
}

/** The type of identifier an identity hash was made from (spec V10). */
export enum IdentityKind {
  FaydaFin = 'fayda_fin',
  FaydaFan = 'fayda_fan',
  Passport = 'passport',
}
