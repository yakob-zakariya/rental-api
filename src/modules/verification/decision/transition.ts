import { VerificationOutcome } from '../verification.enums.js';
import { DiditStatusClass } from './status-mapping.js';

export interface TransitionInput {
  /** The attempt's current outcome. */
  outcome: VerificationOutcome;
  /** decided_by_admin_id is set: staff decisions are final (V15). */
  decidedByStaff: boolean;
  status: DiditStatusClass;
}

export type Transition =
  /** Only provider_status changes. */
  | { kind: 'record_only'; reason: RecordOnlyReason }
  /** Didit approved: run V4–V8 and V17 to decide the outcome. */
  | { kind: 'evaluate_approval' }
  | {
      kind: 'set_outcome';
      outcome:
        | VerificationOutcome.Declined
        | VerificationOutcome.Abandoned
        | VerificationOutcome.Expired;
    };

export type RecordOnlyReason =
  | 'staff_decided'
  | 'blocked'
  | 'manual_review'
  | 'kyc_expired'
  | 'unknown_status'
  /** V12: a late non-final status after a final outcome. */
  | 'late_non_final'
  /** Didit Abandoned/Expired for an attempt that is no longer pending. */
  | 'not_pending'
  /** Same outcome again (e.g. a repeated decision). */
  | 'unchanged';

const {
  Pending,
  Approved,
  Declined,
  Abandoned,
  Expired,
  Blocked,
  ManualReview,
} = VerificationOutcome;

/** Outcomes a final Didit Approved/Declined may still change (V15). */
const DIDIT_MAY_DECIDE = [Pending, Abandoned, Expired, Approved, Declined];

/**
 * What a Didit status may change on an attempt (spec V12, V15). Pure: no I/O.
 * Order matters: staff decisions, blocked and manual_review are never touched by Didit.
 */
export function decideTransition({
  outcome,
  decidedByStaff,
  status,
}: TransitionInput): Transition {
  if (decidedByStaff) return recordOnly('staff_decided');
  if (outcome === Blocked) return recordOnly('blocked');
  if (outcome === ManualReview) return recordOnly('manual_review');

  switch (status) {
    case DiditStatusClass.Unknown:
      return recordOnly('unknown_status');
    case DiditStatusClass.KycExpired:
      return recordOnly('kyc_expired');
    case DiditStatusClass.Pending:
      return recordOnly(outcome === Pending ? 'unchanged' : 'late_non_final');
    case DiditStatusClass.Approved:
      if (outcome === Approved) return recordOnly('unchanged');
      return DIDIT_MAY_DECIDE.includes(outcome)
        ? { kind: 'evaluate_approval' }
        : recordOnly('not_pending');
    case DiditStatusClass.Declined:
      if (outcome === Declined) return recordOnly('unchanged');
      // Approved → Declined is a reversal (V15); the caller handles its side effects.
      return DIDIT_MAY_DECIDE.includes(outcome)
        ? { kind: 'set_outcome', outcome: Declined }
        : recordOnly('not_pending');
    case DiditStatusClass.Abandoned:
    case DiditStatusClass.Expired:
      return outcome === Pending
        ? {
            kind: 'set_outcome',
            outcome:
              status === DiditStatusClass.Abandoned ? Abandoned : Expired,
          }
        : recordOnly('not_pending');
  }
}

const recordOnly = (reason: RecordOnlyReason): Transition => ({
  kind: 'record_only',
  reason,
});
