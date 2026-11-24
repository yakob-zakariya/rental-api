/** Every staff action recorded in admin_actions (spec S1). */
export enum AdminActionType {
  AdminLogin = 'admin.login',
  VerificationApprove = 'verification.approve',
  VerificationDecline = 'verification.decline',
  UserBan = 'user.ban',
  UserUnban = 'user.unban',
  NeighbourhoodCreate = 'neighbourhood.create',
  NeighbourhoodUpdate = 'neighbourhood.update',
  NeighbourhoodDeactivate = 'neighbourhood.deactivate',
  NeighbourhoodReactivate = 'neighbourhood.reactivate',
  ListingApprove = 'listing.approve',
  ListingReject = 'listing.reject',
  ListingTakedown = 'listing.takedown',
  /** A reviewer saw the lister's phone number (T4.1, decided 2026-11-24). */
  ListingRevealListerPhone = 'listing.reveal_lister_phone',
}

/** What an admin action was done to. */
export enum AuditTargetType {
  AdminUser = 'admin_user',
  User = 'user',
  IdentityVerification = 'identity_verification',
  Neighbourhood = 'neighbourhood',
  Listing = 'listing',
}
