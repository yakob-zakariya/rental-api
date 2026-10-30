import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRefreshTokens1793385121014 implements MigrationInterface {
  name = 'CreateRefreshTokens1793385121014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "refresh_tokens" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "user_id" uuid NOT NULL,
                "token_hash" character varying(64) NOT NULL,
                "device_name" character varying(100),
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "revoked_at" TIMESTAMP WITH TIME ZONE,
                "replaced_by_id" uuid,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens"
            ADD CONSTRAINT "FK_refresh_tokens_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens"
            ADD CONSTRAINT "FK_refresh_tokens_replaced_by_id" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_refresh_tokens_replaced_by_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_refresh_tokens_user_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_refresh_tokens_user_id"
        `);
    await queryRunner.query(`
            DROP TABLE "refresh_tokens"
        `);
  }
}
