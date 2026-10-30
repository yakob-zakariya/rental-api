import { VerificationStatus } from '../users/user.enums.js';
import { VerificationOutcome } from './verification.enums.js';

/**
 * The user's verification status, derived from their attempts (spec "recomputeVerificationStatus"):
 * 1. any attempt blocked → blocked
 * 2. else any attempt approved → approved
 * 3. else the most recent attempt that isn't abandoned/expired → its outcome
 * 4. else → not_verified
 * `outcomes` must be ordered newest first.
 */
export function deriveVerificationStatus(
  outcomes: readonly VerificationOutcome[],
): VerificationStatus {
  if (outcomes.includes(VerificationOutcome.Blocked))
    return VerificationStatus.Blocked;
  if (outcomes.includes(VerificationOutcome.Approved))
    return VerificationStatus.Approved;

  const latest = outcomes.find(
    (o) =>
      o !== VerificationOutcome.Abandoned && o !== VerificationOutcome.Expired,
  );
  switch (latest) {
    case VerificationOutcome.Pending:
      return VerificationStatus.Pending;
    case VerificationOutcome.Declined:
      return VerificationStatus.Declined;
    case VerificationOutcome.ManualReview:
      return VerificationStatus.ManualReview;
    default:
      return VerificationStatus.NotVerified;
  }
}
