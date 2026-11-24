import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written (T6.2): devices are addressed by their Firebase Installation ID (FID) instead of a
 * registration token, which Firebase has deprecated. Rows registered with tokens can't be turned
 * into FIDs, so they're deleted; the app registers again on its next start.
 */
export class DeviceInstallationIds1795548623593 implements MigrationInterface {
  name = 'DeviceInstallationIds1795548623593';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "devices"`);
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME COLUMN "fcm_token" TO "installation_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "installation_id" TYPE varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME CONSTRAINT "UQ_devices_fcm_token" TO "UQ_devices_installation_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT "CHK_devices_fcm_token"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "CHK_devices_installation_id" CHECK ("installation_id" ~ '\\S')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT "CHK_devices_installation_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "CHK_devices_fcm_token" CHECK ("installation_id" ~ '\\S')`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME CONSTRAINT "UQ_devices_installation_id" TO "UQ_devices_fcm_token"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "installation_id" TYPE varchar(4096)`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" RENAME COLUMN "installation_id" TO "fcm_token"`,
    );
  }
}
