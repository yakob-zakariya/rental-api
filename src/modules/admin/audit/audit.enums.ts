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
}

/** What an admin action was done to. */
export enum AuditTargetType {
  AdminUser = 'admin_user',
  User = 'user',
  IdentityVerification = 'identity_verification',
  Neighbourhood = 'neighbourhood',
}
