import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdminUsers1793446564364 implements MigrationInterface {
  name = 'CreateAdminUsers1793446564364';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."admin_role" AS ENUM('support', 'moderator', 'super_admin')
        `);
    await queryRunner.query(`
            CREATE TABLE "admin_users" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "email" character varying(254) NOT NULL,
                "password_hash" character varying(255) NOT NULL,
                "role" "public"."admin_role" NOT NULL,
                "is_active" boolean NOT NULL DEFAULT true,
                "last_login_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_admin_users_email" UNIQUE ("email"),
                CONSTRAINT "CHK_admin_users_email_lowercase" CHECK ("email" = lower("email")),
                CONSTRAINT "PK_06744d221bb6145dc61e5dc441d" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities"
            ADD CONSTRAINT "FK_banned_identities_banned_by_admin_id" FOREIGN KEY ("banned_by_admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities"
            ADD CONSTRAINT "FK_banned_identities_lifted_by_admin_id" FOREIGN KEY ("lifted_by_admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications"
            ADD CONSTRAINT "FK_identity_verifications_decided_by_admin_id" FOREIGN KEY ("decided_by_admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "identity_verifications" DROP CONSTRAINT "FK_identity_verifications_decided_by_admin_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities" DROP CONSTRAINT "FK_banned_identities_lifted_by_admin_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "banned_identities" DROP CONSTRAINT "FK_banned_identities_banned_by_admin_id"
        `);
    await queryRunner.query(`
            DROP TABLE "admin_users"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."admin_role"
        `);
  }
}
