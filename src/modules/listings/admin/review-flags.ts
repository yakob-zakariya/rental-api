import { type ContactKind, findContacts } from './contact-detection.js';

/**
 * Hints for the reviewer (spec R1). They never block anything by themselves. PHOTO_MATCH (P3)
 * joins them with photo hashing (T3.3): one more entry in reviewFlags().
 */
export type ReviewFlag =
  | { code: 'MANY_ACTIVE_LISTINGS'; activeListings: number }
  | { code: 'UNLISTED_NEIGHBOURHOOD'; name: string }
  | {
      code: 'CONTACT_IN_TEXT';
      found: { field: ContactField; kinds: ContactKind[] }[];
    };

export type ReviewFlagCode = ReviewFlag['code'];

/** More active listings than this, in any area, counting this one (P2-1, decided 2026-11-09). */
export const MANY_ACTIVE_LISTINGS_ABOVE = 2;

/** The lister's free text, where contact details would bypass contact requests. */
export const CONTACT_FIELDS = [
  'description',
  'landmark',
  'unlistedNeighbourhoodName',
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

export interface FlagInput {
  /** The lister's listings in pending_review, live or stale (this one included if it is). */
  activeListings: number;
  description: string | null;
  landmark: string | null;
  unlistedNeighbourhoodName: string | null;
}

export function reviewFlags(input: FlagInput): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (input.activeListings > MANY_ACTIVE_LISTINGS_ABOVE)
    flags.push({
      code: 'MANY_ACTIVE_LISTINGS',
      activeListings: input.activeListings,
    });
  if (input.unlistedNeighbourhoodName)
    flags.push({
      code: 'UNLISTED_NEIGHBOURHOOD',
      name: input.unlistedNeighbourhoodName,
    });
  const found = CONTACT_FIELDS.flatMap((field) => {
    const kinds = findContacts(input[field] ?? '');
    return kinds.length > 0 ? [{ field, kinds }] : [];
  });
  if (found.length > 0) flags.push({ code: 'CONTACT_IN_TEXT', found });
  return flags;
}
