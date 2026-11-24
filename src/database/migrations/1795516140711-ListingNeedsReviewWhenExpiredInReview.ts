import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written (decided 2026-11-24): a listing that expires while in review (pending_review →
 * expired, e.g. by a ban, L8) is marked needs_review, so reopening it (L6) goes back to review
 * instead of straight to live with changes nobody approved. In the database, so it holds for
 * every code path that makes that move, now and later (T7.1's ban, any job).
 */
export class ListingNeedsReviewWhenExpiredInReview1795516140711 implements MigrationInterface {
  name = 'ListingNeedsReviewWhenExpiredInReview1795516140711';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE FUNCTION "listings_needs_review_when_expired_in_review"() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              NEW.needs_review := true;
              RETURN NEW;
            END
            $$
        `);
    await queryRunner.query(`
            CREATE TRIGGER "listings_needs_review_when_expired_in_review"
            BEFORE UPDATE OF "status" ON "listings"
            FOR EACH ROW
            WHEN (OLD.status = 'pending_review' AND NEW.status = 'expired')
            EXECUTE FUNCTION "listings_needs_review_when_expired_in_review"()
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TRIGGER "listings_needs_review_when_expired_in_review" ON "listings"
        `);
    await queryRunner.query(`
            DROP FUNCTION "listings_needs_review_when_expired_in_review"()
        `);
  }
}
