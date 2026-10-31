import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProviderIdentityFields1793449735630 implements MigrationInterface {
  name = 'AddProviderIdentityFields1793449735630';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "identity_verifications"
            ADD "provider_verified_name" character varying
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications"
            ADD "provider_date_of_birth" date
        `);
    // Hand-added: everything stored so far came from Didit, so it is the provider's value too.
    await queryRunner.query(`
            UPDATE "identity_verifications"
            SET "provider_verified_name" = "verified_name", "provider_date_of_birth" = "date_of_birth"
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "identity_verifications" DROP COLUMN "provider_date_of_birth"
        `);
    await queryRunner.query(`
            ALTER TABLE "identity_verifications" DROP COLUMN "provider_verified_name"
        `);
  }
}
