import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdminActions1793448713609 implements MigrationInterface {
  name = 'CreateAdminActions1793448713609';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "admin_actions" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "admin_id" uuid NOT NULL,
                "action" character varying(64) NOT NULL,
                "target_type" character varying(32) NOT NULL,
                "target_id" uuid NOT NULL,
                "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_08d0b319675c4968ff9e0dca4c3" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_admin_actions_admin_id_created_at" ON "admin_actions" ("admin_id", "created_at")
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_admin_actions_target_id_created_at" ON "admin_actions" ("target_id", "created_at")
        `);
    await queryRunner.query(`
            ALTER TABLE "admin_actions"
            ADD CONSTRAINT "FK_admin_actions_admin_id" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    // Hand-added: the audit log is append-only (spec S1). UPDATE and DELETE are rejected even
    // for our own code; TRUNCATE (used by tests) is not a row operation, so the deployment
    // checklist also removes TRUNCATE/UPDATE/DELETE from the production DB user.
    await queryRunner.query(`
            CREATE FUNCTION "admin_actions_append_only"() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'admin_actions is append-only (% is not allowed)', TG_OP
                USING ERRCODE = 'insufficient_privilege';
            END
            $$
        `);
    await queryRunner.query(`
            CREATE TRIGGER "admin_actions_no_update_or_delete"
            BEFORE UPDATE OR DELETE ON "admin_actions"
            FOR EACH ROW EXECUTE FUNCTION "admin_actions_append_only"()
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TRIGGER "admin_actions_no_update_or_delete" ON "admin_actions"
        `);
    await queryRunner.query(`
            DROP FUNCTION "admin_actions_append_only"()
        `);
    await queryRunner.query(`
            ALTER TABLE "admin_actions" DROP CONSTRAINT "FK_admin_actions_admin_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_admin_actions_target_id_created_at"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_admin_actions_admin_id_created_at"
        `);
    await queryRunner.query(`
            DROP TABLE "admin_actions"
        `);
  }
}
