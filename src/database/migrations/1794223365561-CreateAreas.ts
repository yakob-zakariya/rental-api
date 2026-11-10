import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAreas1794223365561 implements MigrationInterface {
  name = 'CreateAreas1794223365561';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "sub_cities" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "city" character varying(64) NOT NULL,
                "name_en" character varying(100) NOT NULL,
                "name_am" character varying(100) NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_sub_cities_city_name_en" UNIQUE ("city", "name_en"),
                CONSTRAINT "CHK_sub_cities_names_not_blank" CHECK (
                    btrim("name_en") <> ''
                    AND btrim("name_am") <> ''
                ),
                CONSTRAINT "PK_8cbbc27d9687ad55c05252f0f16" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "neighbourhoods" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "sub_city_id" uuid NOT NULL,
                "name_en" character varying(100) NOT NULL,
                "name_am" character varying(100) NOT NULL,
                "created_by_admin_id" uuid,
                "deactivated_at" TIMESTAMP WITH TIME ZONE,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_neighbourhoods_names_not_blank" CHECK (
                    btrim("name_en") <> ''
                    AND btrim("name_am") <> ''
                ),
                CONSTRAINT "PK_b38b737170a483f9c4a3087af64" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "neighbourhoods"
            ADD CONSTRAINT "FK_neighbourhoods_sub_city_id" FOREIGN KEY ("sub_city_id") REFERENCES "sub_cities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "neighbourhoods"
            ADD CONSTRAINT "FK_neighbourhoods_created_by_admin_id" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    // Hand-added (spec section 2): one English name per sub-city, ignoring letter case, with
    // deactivated rows included, so a deactivated name is reactivated rather than added
    // again. Also serves "neighbourhoods of this sub-city".
    await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_neighbourhoods_sub_city_id_lower_name_en" ON "neighbourhoods" ("sub_city_id", lower("name_en"))
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."UQ_neighbourhoods_sub_city_id_lower_name_en"
        `);
    await queryRunner.query(`
            ALTER TABLE "neighbourhoods" DROP CONSTRAINT "FK_neighbourhoods_created_by_admin_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "neighbourhoods" DROP CONSTRAINT "FK_neighbourhoods_sub_city_id"
        `);
    await queryRunner.query(`
            DROP TABLE "neighbourhoods"
        `);
    await queryRunner.query(`
            DROP TABLE "sub_cities"
        `);
  }
}
