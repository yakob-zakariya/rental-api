import { MigrationInterface, QueryRunner } from 'typeorm';

// postgis: geography columns for "near me" search (later phases).
// pgcrypto: crypto functions; uuid defaults use gen_random_uuid(), which is core since Postgres 13.
const EXTENSIONS = ['postgis', 'pgcrypto'] as const;

// Some databases already have an extension before this migration runs (the postgis/postgis image
// creates postgis itself). up() tags only the extensions it creates, and down() drops only those,
// so reverting never removes something this migration didn't add.
const CREATED_BY_THIS_MIGRATION =
  'created by migration EnableExtensions1793371777514';

export class EnableExtensions1793371777514 implements MigrationInterface {
  name = 'EnableExtensions1793371777514';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const extension of EXTENSIONS) {
      const existing: unknown[] = await queryRunner.query(
        `SELECT 1 FROM pg_extension WHERE extname = $1`,
        [extension],
      );
      if (existing.length > 0) continue;

      await queryRunner.query(`CREATE EXTENSION "${extension}"`);
      await queryRunner.query(
        `COMMENT ON EXTENSION "${extension}" IS '${CREATED_BY_THIS_MIGRATION}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const extension of [...EXTENSIONS].reverse()) {
      const ours: unknown[] = await queryRunner.query(
        `SELECT 1 FROM pg_extension
         WHERE extname = $1 AND obj_description(oid, 'pg_extension') = $2`,
        [extension, CREATED_BY_THIS_MIGRATION],
      );
      if (ours.length === 0) continue;

      // No CASCADE: if anything still depends on the extension, fail rather than drop it.
      await queryRunner.query(`DROP EXTENSION "${extension}"`);
    }
  }
}
