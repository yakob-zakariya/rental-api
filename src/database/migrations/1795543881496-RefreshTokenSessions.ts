import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshTokenSessions1795543881496 implements MigrationInterface {
  name = 'RefreshTokenSessions1795543881496';

  /**
   * Hand-edited (T6.1): a sign-in session keeps one id through rotation (the first token's id), so
   * push devices can end with their session. Existing rows are filled in by walking each rotation
   * chain (replaced_by_id) back to its first token before the column becomes NOT NULL. A retry
   * after a lost response (rule A5) points two rows at one replacement; both lead to the same
   * first token, so the result is the same either way.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens"
            ADD "session_id" uuid
        `);
    await queryRunner.query(`
            WITH RECURSIVE chain (id, session_id) AS (
              SELECT r.id, r.id FROM "refresh_tokens" r
              WHERE NOT EXISTS (SELECT 1 FROM "refresh_tokens" p WHERE p.replaced_by_id = r.id)
              UNION
              SELECT next.id, chain.session_id
              FROM chain
              JOIN "refresh_tokens" cur ON cur.id = chain.id
              JOIN "refresh_tokens" next ON next.id = cur.replaced_by_id
            )
            UPDATE "refresh_tokens" r SET session_id = chain.session_id
            FROM chain WHERE chain.id = r.id
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_refresh_tokens_session_id" ON "refresh_tokens" ("session_id")
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."IDX_refresh_tokens_session_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "refresh_tokens" DROP COLUMN "session_id"
        `);
  }
}
