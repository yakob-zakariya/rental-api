import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPhotoThumbnails1795528521011 implements MigrationInterface {
  name = 'AddPhotoThumbnails1795528521011';

  // Thumbnails for browse cards (T3.4). Null for photos uploaded before (development data).
  // The constraint name is set by hand: TypeORM generates a hashed one when adding a unique
  // constraint to an existing table.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "property_photos"
            ADD "thumbnail_key" character varying(255)
        `);
    await queryRunner.query(`
            ALTER TABLE "property_photos"
            ADD CONSTRAINT "UQ_property_photos_thumbnail_key" UNIQUE ("thumbnail_key")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "property_photos" DROP CONSTRAINT "UQ_property_photos_thumbnail_key"
        `);
    await queryRunner.query(`
            ALTER TABLE "property_photos" DROP COLUMN "thumbnail_key"
        `);
  }
}
