import { MigrationInterface, QueryRunner } from 'typeorm';

/** The weekly "still available?" checks (spec F1–F6; T6.3), and the trigger below. */
export class CreateAvailabilityChecks1795551273671 implements MigrationInterface {
  name = 'CreateAvailabilityChecks1795551273671';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."push_result" AS ENUM('sent', 'no_device', 'failed')
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."availability_check_outcome" AS ENUM(
                'available',
                'not_available',
                'no_answer',
                'cancelled'
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "availability_checks" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "listing_id" uuid NOT NULL,
                "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "push_result" "public"."push_result",
                "closed_at" TIMESTAMP WITH TIME ZONE,
                "outcome" "public"."availability_check_outcome",
                "responded_at" TIMESTAMP WITH TIME ZONE,
                "stale_pushed_at" TIMESTAMP WITH TIME ZONE,
                "stale_push_result" "public"."push_result",
                CONSTRAINT "CHK_availability_checks_stale_push" CHECK (
                    "stale_pushed_at" IS NULL
                    OR COALESCE("outcome" = 'no_answer', false)
                ),
                CONSTRAINT "CHK_availability_checks_responded" CHECK (
                    ("responded_at" IS NOT NULL) = COALESCE(
                        "outcome" IN ('available', 'not_available'),
                        false
                    )
                ),
                CONSTRAINT "CHK_availability_checks_closed" CHECK (("closed_at" IS NULL) = ("outcome" IS NULL)),
                CONSTRAINT "PK_2530fc18de6afecfde27e45f148" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_availability_checks_listing_sent" ON "availability_checks" ("listing_id", "sent_at")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_availability_checks_one_open" ON "availability_checks" ("listing_id")
            WHERE "closed_at" IS NULL
        `);
    await queryRunner.query(`
            ALTER TABLE "availability_checks"
            ADD CONSTRAINT "FK_availability_checks_listing_id" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    // Hand-written (decided 2026-11-24): a listing that leaves live by any path that didn't
    // close its check (an edit back to review, a close, a takedown, a ban) gets the check
    // cancelled, so a re-approval doesn't find an old open check and mark it stale at once.
    // The job (stale) and the answers close their check first, so this finds nothing then.
    await queryRunner.query(`
            CREATE FUNCTION "listings_cancel_open_check"() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              UPDATE "availability_checks" SET closed_at = now(), outcome = 'cancelled'
              WHERE listing_id = NEW.id AND closed_at IS NULL;
              RETURN NULL;
            END
            $$
        `);
    await queryRunner.query(`
            CREATE TRIGGER "listings_cancel_open_check"
            AFTER UPDATE OF "status" ON "listings"
            FOR EACH ROW
            WHEN (OLD.status = 'live' AND NEW.status <> 'live')
            EXECUTE FUNCTION "listings_cancel_open_check"()
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TRIGGER "listings_cancel_open_check" ON "listings"
        `);
    await queryRunner.query(`
            DROP FUNCTION "listings_cancel_open_check"()
        `);
    await queryRunner.query(`
            ALTER TABLE "availability_checks" DROP CONSTRAINT "FK_availability_checks_listing_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."UQ_availability_checks_one_open"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_availability_checks_listing_sent"
        `);
    await queryRunner.query(`
            DROP TABLE "availability_checks"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."availability_check_outcome"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."push_result"
        `);
  }
}
