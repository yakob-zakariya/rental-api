import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePropertyPhotos1795519951108 implements MigrationInterface {
  name = 'CreatePropertyPhotos1795519951108';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "property_photos" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "property_id" uuid NOT NULL,
                "storage_key" character varying(255) NOT NULL,
                "width" integer NOT NULL,
                "height" integer NOT NULL,
                "bytes" integer NOT NULL,
                "position" integer NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_property_photos_property_id_position" UNIQUE ("property_id", "position") DEFERRABLE INITIALLY DEFERRED,
                CONSTRAINT "UQ_property_photos_storage_key" UNIQUE ("storage_key"),
                CONSTRAINT "CHK_property_photos_size" CHECK (
                    "width" > 0
                    AND "height" > 0
                    AND "bytes" > 0
                ),
                CONSTRAINT "CHK_property_photos_position" CHECK ("position" >= 0),
                CONSTRAINT "PK_8010be3009e411f5682e77b65bf" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "property_photos"
            ADD CONSTRAINT "FK_property_photos_property_id" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "property_photos" DROP CONSTRAINT "FK_property_photos_property_id"
        `);
    await queryRunner.query(`
            DROP TABLE "property_photos"
        `);
  }
}
