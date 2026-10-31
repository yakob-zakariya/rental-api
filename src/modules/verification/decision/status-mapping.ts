import { DiditStatus } from '../didit/didit.types.js';

/** What a Didit session status means for our attempt (spec §4 "Status mapping"). */
export enum DiditStatusClass {
  /** Not final at Didit: Not Started, In Progress, In Review, Resubmitted, Awaiting User. */
  Pending = 'pending',
  /** Run our own checks (V4–V8, V17). */
  Approved = 'approved',
  Declined = 'declined',
  Abandoned = 'abandoned',
  Expired = 'expired',
  /** An approved document passed its expiry date: record provider_status only. */
  KycExpired = 'kyc_expired',
  /** A status Didit's docs don't list: record provider_status only, and log it. */
  Unknown = 'unknown',
}

const CLASS_BY_STATUS: Record<string, DiditStatusClass> = {
  [DiditStatus.NotStarted]: DiditStatusClass.Pending,
  [DiditStatus.InProgress]: DiditStatusClass.Pending,
  [DiditStatus.InReview]: DiditStatusClass.Pending,
  [DiditStatus.Resubmitted]: DiditStatusClass.Pending,
  [DiditStatus.AwaitingUser]: DiditStatusClass.Pending,
  [DiditStatus.Approved]: DiditStatusClass.Approved,
  [DiditStatus.Declined]: DiditStatusClass.Declined,
  [DiditStatus.Abandoned]: DiditStatusClass.Abandoned,
  [DiditStatus.Expired]: DiditStatusClass.Expired,
  [DiditStatus.KycExpired]: DiditStatusClass.KycExpired,
};

/** Exact, case-sensitive match on Didit's strings; anything else is Unknown. */
export function classifyDiditStatus(status: string): DiditStatusClass {
  return Object.hasOwn(CLASS_BY_STATUS, status)
    ? CLASS_BY_STATUS[status]
    : DiditStatusClass.Unknown;
}
