import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-edited: TypeORM emitted CREATE TYPE / DROP TYPE "identity_kind" once for each table that
// uses it (identity_hashes and banned_identities). The type is created once and dropped last.

export class CreateVerificationTables1793387810723 implements MigrationInterface {
  name = 'CreateVerificationTables1793387810723';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."identity_kind" AS ENUM('fayda_fin', 'fayda_fan', 'passport')
        `);
    await queryRunner.query(`
            CREATE TABLE "banned_identities" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "user_id" uuid NOT NULL,
                "kind" "public"."identity_kind" NOT NULL,
                "hash" character varying(64) NOT NULL,
                "reason" character varying(255) NOT NULL,
                "banned_by_admin_id" uuid NOT NULL,
                "lifted_at" TIMESTAMP WITH TIME ZONE,
                "lifted_by_admin_id" uuid,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_0d20aa7c2af67e9e46b4cc21618" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_banned_identities_hash_active" ON "banned_identities" ("hash")
            WHERE "lifted_at" IS NULL
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_banned_identities_hash" ON "banned_identities" ("hash")
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."verification_outcome" AS ENUM(
                'pending',
                'approved',
                'declined',
                'manual_review',
                'blocked',
                'abandoned',
                'expired'
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "identity_verifications" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "user_id" uuid NOT NULL,
                "provider" character varying(32) NOT NULL DEFAULT 'didit',
                "provider_session_id" character varying(64) NOT NULL,
                "provider_status" character varying(32) NOT NULL,
                "outcome" "public"."verification_outcome" NOT NULL DEFAULT 'pending',
                "decline_reason" character varying(64),
                "document_type" character varying(64),
                "verified_name" character varying,
                "date_of_birth" date,
                "verification_url" character varying(2048),
                "session_token" character varying(255),
                "manual_review_requested_at" TIMESTAMP WITH TIME ZONE,
                "flagged_at" TIMESTAMP WITH TIME ZONE,
                "flag_reason" character varying(64),
                "decided_by_admin_id" uuid,
                "decided_at" TIMESTAMP WITH TIME ZONE,
                "completed_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_identity_verifications_provider_session_id" UNIQUE ("provider_session_id"),
                CONSTRAINT "CHK_identity_verifications_flag_pair" CHECK (("flagged_at" IS NULL) = ("flag_reason" IS NULL)),
                CONSTRAINT "CHK_identity_verifications_decided_pair" CHECK (
                    ("decided_by_admin_id" IS NULL) = ("decided_at" IS NULL)
                ),
                CONSTRAINT "CHK_identity_verifications_resume_only_pending" CHECK (
                    "outcome" = 'pending'
                    OR (
                        "verification_url" IS NULL
                        AND "session_token" IS NULL
                    )
                ),
                CONSTRAINT "PK_42a93e679bc1d9568b6e80ea080" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_identity_verifications_user_id_created_at" ON "identity_verifications" ("user_id", "created_at")
        `);
    await queryRunner.query(`
            CREATE TABLE "identity_hashes" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "verification_id" uuid NOT NULL,
                "user_id" uuid NOT NULL,
                "kind" "public"."identity_kind" NOT NULL,
                "hash" character varying(64) NOT NULL,
                "is_approved" boolean NOT NULL DEFAULT false,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_identity_hashes_verification_hash" UNIQUE ("verification_id", "hash"),
                CONSTRAINT "PK_cc7dfbefd3182447dfbfcada4f0" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_identity_hashes_hash_approved" ON "identity_hashes" ("hash")
            WHERE "is_approved"
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_identity_hashes_hash" ON "identity_hashes" ("hash")
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_identity_hashes_user_id" ON "identity_hashes" ("user_id")
        `);
    await queryRunner.query(`
            CREATE TABLE "verification_webhook_events" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "event_key" character varying(64) NOT NULL,
                "webhook_type" character varying(64) NOT NULL,
                "provider_session_id" character varying(64) NOT NULL,
                "provider_status" character varying(32),
                "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "processed_at" TIMESTAMP WITH TIME ZONE,
                "error" text,
                CONSTRAINT "UQ_verification_webhook_events_event_key" UNIQUE ("event_key"),
                CONSTRAINT "PK_d3b64e45b3789ad2fd058d97024" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_verification_webhook_events_provider_session_id" ON "verification_webhook_events" ("provider_session_id")
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities"
            ADD CONSTRAINT "FK_banned_identities_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications"
            ADD CONSTRAINT "FK_identity_verifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_hashes"
            ADD CONSTRAINT "FK_identity_hashes_verification_id" FOREIGN KEY ("verification_id") REFERENCES "identity_verifications"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_hashes"
            ADD CONSTRAINT "FK_identity_hashes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "identity_hashes" DROP CONSTRAINT "FK_identity_hashes_user_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_hashes" DROP CONSTRAINT "FK_identity_hashes_verification_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications" DROP CONSTRAINT "FK_identity_verifications_user_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities" DROP CONSTRAINT "FK_banned_identities_user_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_verification_webhook_events_provider_session_id"
        `);
    await queryRunner.query(`
            DROP TABLE "verification_webhook_events"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_identity_hashes_user_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_identity_hashes_hash"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."UQ_identity_hashes_hash_approved"
        `);
    await queryRunner.query(`
            DROP TABLE "identity_hashes"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_identity_verifications_user_id_created_at"
        `);
    await queryRunner.query(`
            DROP TABLE "identity_verifications"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."verification_outcome"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_banned_identities_hash"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."UQ_banned_identities_hash_active"
        `);
    await queryRunner.query(`
            DROP TABLE "banned_identities"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."identity_kind"
        `);
  }
}
