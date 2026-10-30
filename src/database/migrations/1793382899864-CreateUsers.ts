import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1793382899864 implements MigrationInterface {
  name = 'CreateUsers1793382899864';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."user_language" AS ENUM('am', 'om', 'en')
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'banned')
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."verification_status" AS ENUM(
                'not_verified',
                'pending',
                'approved',
                'declined',
                'manual_review',
                'blocked'
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "users" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "phone" character varying(16) NOT NULL,
                "full_name" character varying,
                "date_of_birth" date,
                "preferred_language" "public"."user_language" NOT NULL DEFAULT 'am',
                "status" "public"."user_status" NOT NULL DEFAULT 'active',
                "verification_status" "public"."verification_status" NOT NULL DEFAULT 'not_verified',
                "verified_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_users_phone" UNIQUE ("phone"),
                CONSTRAINT "CHK_users_phone_e164" CHECK ("phone" ~ '^\\+[1-9][0-9]{7,14}$'),
                CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "users"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."verification_status"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."user_status"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."user_language"
        `);
  }
}
