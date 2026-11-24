import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written (T5.1): browse's default order, newest first, for live listings only (G5). Partial,
 * so it stays small as closed listings pile up; ties are broken by id, as the cursor does.
 */
export class BrowseNewestIndex1795539079992 implements MigrationInterface {
  name = 'BrowseNewestIndex1795539079992';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE INDEX "IDX_listings_live_newest" ON "listings" ("published_at" DESC, "id" DESC)
            WHERE "status" = 'live'
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."IDX_listings_live_newest"
        `);
  }
}
