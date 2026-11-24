import { MigrationInterface, QueryRunner } from 'typeorm';

export class ThumbnailKeyNotNull1795538938183 implements MigrationInterface {
  name = 'ThumbnailKeyNotNull1795538938183';

  // Every photo has a thumbnail (T3.4); there is no production data, and no fallback for photos
  // without one (decided 2026-11-24). Postgres refuses this if any row lacks a thumbnail.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "property_photos"
            ALTER COLUMN "thumbnail_key"
            SET NOT NULL
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "property_photos"
            ALTER COLUMN "thumbnail_key" DROP NOT NULL
        `);
  }
}
