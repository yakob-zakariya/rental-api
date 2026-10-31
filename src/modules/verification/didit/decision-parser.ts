import type { DiditIdVerification } from './didit.types.js';

type Json = Record<string, unknown>;

/**
 * Trims Didit's decision.id_verifications[] (from the decision endpoint or a webhook payload) to
 * an explicit allow-list. Image URLs, address, MRZ and every other field are never copied
 * (hard rule 1). Non-object items are skipped.
 */
export function trimIdVerifications(
  items: readonly unknown[],
): DiditIdVerification[] {
  return items.filter(isObject).map((item) => ({
    status: str(item.status),
    documentType: str(item.document_type),
    documentSubtype: str(item.document_subtype),
    documentNumber: str(item.document_number),
    personalNumber: str(item.personal_number),
    issuingState: str(item.issuing_state),
    dateOfBirth: str(item.date_of_birth),
    fullName: str(item.full_name),
    firstName: str(item.first_name),
    lastName: str(item.last_name),
  }));
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
