import type { EntityManager } from 'typeorm';
import { CheckOutcome } from './availability-check.entity.js';

/**
 * Closes the listing's open check, if it has one, with the lister's answer (F2). The caller
 * holds the listing lock. Answers set responded_at; the job's no_answer doesn't.
 */
export async function closeOpenCheck(
  manager: EntityManager,
  listingId: string,
  outcome: CheckOutcome,
): Promise<void> {
  const answered =
    outcome === CheckOutcome.Available || outcome === CheckOutcome.NotAvailable;
  await manager.query(
    `UPDATE availability_checks
     SET closed_at = now(), outcome = $2,
         responded_at = CASE WHEN $3::boolean THEN now() END
     WHERE listing_id = $1 AND closed_at IS NULL`,
    [listingId, outcome, answered],
  );
}
