import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateServiceArea1794316364808 implements MigrationInterface {
  name = 'CreateServiceArea1794316364808';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "service_area" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "city" character varying(64) NOT NULL,
                "boundary" geography(MultiPolygon, 4326) NOT NULL,
                "source" character varying(255) NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_service_area_city" UNIQUE ("city"),
                CONSTRAINT "PK_9daeb85378e2c59f1d2e68665cb" PRIMARY KEY ("id")
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "service_area"
        `);
  }
}
