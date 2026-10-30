import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOtpCodes1793384484788 implements MigrationInterface {
  name = 'CreateOtpCodes1793384484788';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "otp_codes" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "phone" character varying(16) NOT NULL,
                "code_hash" character varying(64) NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "attempts" integer NOT NULL DEFAULT '0',
                "consumed_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_otp_codes_phone_e164" CHECK ("phone" ~ '^\\+[1-9][0-9]{7,14}$'),
                CONSTRAINT "PK_9d0487965ac1837d57fec4d6a26" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_otp_codes_phone_created_at" ON "otp_codes" ("phone", "created_at")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."IDX_otp_codes_phone_created_at"
        `);
    await queryRunner.query(`
            DROP TABLE "otp_codes"
        `);
  }
}
