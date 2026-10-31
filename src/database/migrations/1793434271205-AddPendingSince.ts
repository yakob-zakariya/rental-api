import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPendingSince1793434271205 implements MigrationInterface {
  name = 'AddPendingSince1793434271205';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "identity_verifications"
            ADD "pending_since" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        `);
    // Hand-added: existing attempts have been pending since they were created.
    await queryRunner.query(`
            UPDATE "identity_verifications" SET "pending_since" = "created_at"
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_identity_verifications_pending_since" ON "identity_verifications" ("pending_since")
            WHERE "outcome" = 'pending'
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."IDX_identity_verifications_pending_since"
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications" DROP COLUMN "pending_since"
        `);
  }
}
