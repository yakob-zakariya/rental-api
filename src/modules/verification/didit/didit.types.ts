// Didit API v3 shapes we rely on. Confirmed against Didit's docs on 2026-10-30; details, links and
// real-document findings (T2.9) are in docs/didit-integration.md.

/**
 * Session statuses, exactly as Didit sends them (case-sensitive). Kept as raw strings elsewhere
 * (provider_status is recorded as received), so an unknown future status doesn't break parsing.
 */
export enum DiditStatus {
  NotStarted = 'Not Started',
  InProgress = 'In Progress',
  InReview = 'In Review',
  Resubmitted = 'Resubmitted',
  AwaitingUser = 'Awaiting User',
  Approved = 'Approved',
  Declined = 'Declined',
  Abandoned = 'Abandoned',
  Expired = 'Expired',
  KycExpired = 'Kyc Expired',
}

/** Sent as expected_details.expected_document_types: identity cards and passports only. */
export const EXPECTED_DOCUMENT_TYPES = ['ID', 'P'] as const;

/** From POST /v3/session/. Also returned for an existing unfinished session (Didit reuses it). */
export interface DiditSession {
  sessionId: string;
  /** Short-lived token for the hosted flow / SDK. A secret. */
  sessionToken: string;
  /** Hosted verification URL (Didit calls it `url`). */
  url: string;
  status: string;
}

/**
 * One item of decision.id_verifications[], trimmed to what decision processing needs. Images,
 * address, MRZ and every other field are dropped by the client (hard rule 1).
 */
export interface DiditIdVerification {
  /** Feature-level status, e.g. "Approved", "Declined". */
  status: string | null;
  /** e.g. "Passport", "Identity Card". */
  documentType: string | null;
  /** e.g. "PASSPORT_GENERIC", "ID_CARD_GENERIC". */
  documentSubtype: string | null;
  documentNumber: string | null;
  personalNumber: string | null;
  /** ISO 3166-1 alpha-3, e.g. "ETH". */
  issuingState: string | null;
  /** YYYY-MM-DD, Gregorian (confirmed for Fayda in T2.9). */
  dateOfBirth: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** From GET /v3/session/{id}/decision/, trimmed (see DiditIdVerification). */
export interface DiditDecision {
  sessionId: string;
  status: string;
  vendorData: string | null;
  idVerifications: DiditIdVerification[];
}
