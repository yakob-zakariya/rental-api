import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDevices1795544113220 implements MigrationInterface {
  name = 'CreateDevices1795544113220';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios')
        `);
    await queryRunner.query(`
            CREATE TABLE "devices" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "user_id" uuid NOT NULL,
                "session_id" uuid NOT NULL,
                "fcm_token" character varying(4096) NOT NULL,
                "platform" "public"."device_platform" NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_devices_fcm_token" UNIQUE ("fcm_token"),
                CONSTRAINT "CHK_devices_fcm_token" CHECK ("fcm_token" ~ '\\S'),
                CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_devices_session_id" ON "devices" ("session_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_devices_user_id" ON "devices" ("user_id")
        `);
    await queryRunner.query(`
            ALTER TABLE "devices"
            ADD CONSTRAINT "FK_devices_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "devices" DROP CONSTRAINT "FK_devices_user_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_devices_user_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_devices_session_id"
        `);
    await queryRunner.query(`
            DROP TABLE "devices"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."device_platform"
        `);
  }
}
