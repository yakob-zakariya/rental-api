import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutOfAreaDemand1795437007719 implements MigrationInterface {
  name = 'CreateOutOfAreaDemand1795437007719';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "out_of_area_demand" (
                "lat_rounded" numeric(5, 2) NOT NULL,
                "lng_rounded" numeric(6, 2) NOT NULL,
                "day" date NOT NULL,
                "refusals" integer NOT NULL DEFAULT '1',
                CONSTRAINT "CHK_out_of_area_demand_point" CHECK (
                    "lat_rounded" BETWEEN -90 AND 90
                    AND "lng_rounded" BETWEEN -180 AND 180
                ),
                CONSTRAINT "CHK_out_of_area_demand_refusals" CHECK ("refusals" >= 1),
                CONSTRAINT "PK_out_of_area_demand" PRIMARY KEY ("lat_rounded", "lng_rounded", "day")
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TABLE "out_of_area_demand"
        `);
  }
}
