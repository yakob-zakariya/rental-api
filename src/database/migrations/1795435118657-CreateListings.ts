import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateListings1795435118657 implements MigrationInterface {
  name = 'CreateListings1795435118657';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TYPE "public"."property_type" AS ENUM(
                'condominium',
                'apartment',
                'villa_house',
                'compound_room',
                'studio'
            )
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."amenity" AS ENUM('parking', 'gated_compound', 'guard')
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."lister_relation" AS ENUM('owner', 'representative')
        `);
    await queryRunner.query(`
            CREATE TABLE "properties" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "lister_id" uuid NOT NULL,
                "neighbourhood_id" uuid,
                "unlisted_neighbourhood_name" character varying(100),
                "type" "public"."property_type",
                "bedrooms" integer,
                "bathrooms" integer,
                "furnished" boolean,
                "separate_water_meter" boolean,
                "separate_electricity_meter" boolean,
                "size_m2" integer,
                "floor" integer,
                "amenities" "public"."amenity" array NOT NULL DEFAULT '{}',
                "description" text,
                "location" geography(Point, 4326),
                "approx_location" geography(Point, 4326),
                "landmark" character varying(200),
                "lister_relation" "public"."lister_relation",
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_properties_location_pair" CHECK (
                    ("location" IS NULL) = ("approx_location" IS NULL)
                ),
                CONSTRAINT "CHK_properties_landmark" CHECK ("landmark" ~ '\\S'),
                CONSTRAINT "CHK_properties_unlisted_neighbourhood_name" CHECK ("unlisted_neighbourhood_name" ~ '\\S'),
                CONSTRAINT "CHK_properties_description" CHECK (
                    "description" ~ '\\S'
                    AND char_length("description") <= 2000
                ),
                CONSTRAINT "CHK_properties_floor" CHECK ("floor" >= 0),
                CONSTRAINT "CHK_properties_size_m2" CHECK ("size_m2" > 0),
                CONSTRAINT "CHK_properties_bathrooms" CHECK ("bathrooms" >= 0),
                CONSTRAINT "CHK_properties_bedrooms" CHECK ("bedrooms" >= 0),
                CONSTRAINT "PK_2d83bfa0b9fcd45dee1785af44d" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_properties_lister_id" ON "properties" ("lister_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_properties_approx_location" ON "properties" USING gist ("approx_location")
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."listing_status" AS ENUM(
                'draft',
                'pending_review',
                'live',
                'stale',
                'expired',
                'rented',
                'removed',
                'rejected'
            )
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."listing_close_reason" AS ENUM(
                'rented_in_app',
                'rented_elsewhere',
                'no_longer_for_rent',
                'staff_takedown'
            )
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."staff_reason_code" AS ENUM(
                'PHOTOS_UNCLEAR',
                'PHOTOS_DONT_MATCH',
                'WRONG_LOCATION',
                'MISSING_INFORMATION',
                'DUPLICATE_LISTING',
                'GUIDELINES'
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "listings" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "property_id" uuid NOT NULL,
                "monthly_rent_birr" integer,
                "advance_months" integer,
                "negotiable" boolean,
                "available_from" date,
                "status" "public"."listing_status" NOT NULL DEFAULT 'draft',
                "close_reason" "public"."listing_close_reason",
                "staff_reason_code" "public"."staff_reason_code",
                "lister_note" character varying(300),
                "needs_review" boolean NOT NULL DEFAULT false,
                "version" integer NOT NULL DEFAULT '1',
                "submitted_at" TIMESTAMP WITH TIME ZONE,
                "published_at" TIMESTAMP WITH TIME ZONE,
                "last_confirmed_at" TIMESTAMP WITH TIME ZONE,
                "stale_at" TIMESTAMP WITH TIME ZONE,
                "expired_at" TIMESTAMP WITH TIME ZONE,
                "closed_at" TIMESTAMP WITH TIME ZONE,
                "reviewed_by_admin_id" uuid,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_listings_closed_at" CHECK (
                    ("status" IN ('rented', 'removed')) = ("closed_at" IS NOT NULL)
                ),
                CONSTRAINT "CHK_listings_close_reason" CHECK (
                    (
                        "status" = 'rented'
                        AND "close_reason" IS NOT NULL
                        AND "close_reason" IN ('rented_in_app', 'rented_elsewhere')
                    )
                    OR (
                        "status" = 'removed'
                        AND "close_reason" IS NOT NULL
                        AND "close_reason" IN ('no_longer_for_rent', 'staff_takedown')
                    )
                    OR (
                        "status" NOT IN ('rented', 'removed')
                        AND "close_reason" IS NULL
                    )
                ),
                CONSTRAINT "CHK_listings_complete_unless_draft" CHECK (
                    "status" = 'draft'
                    OR (
                        "monthly_rent_birr" IS NOT NULL
                        AND "advance_months" IS NOT NULL
                        AND "negotiable" IS NOT NULL
                        AND "available_from" IS NOT NULL
                    )
                ),
                CONSTRAINT "CHK_listings_lister_note" CHECK ("lister_note" ~ '\\S'),
                CONSTRAINT "CHK_listings_version" CHECK ("version" >= 1),
                CONSTRAINT "CHK_listings_advance_months" CHECK (
                    "advance_months" BETWEEN 1 AND 12
                ),
                CONSTRAINT "CHK_listings_monthly_rent_birr" CHECK ("monthly_rent_birr" > 0),
                CONSTRAINT "PK_520ecac6c99ec90bcf5a603cdcb" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."listing_history_event" AS ENUM('status', 'monthly_rent', 'available_from')
        `);
    // listing_status, listing_close_reason and staff_reason_code are shared with listings and
    // already exist (TypeORM generated them twice; removed by hand).
    await queryRunner.query(`
            CREATE TYPE "public"."actor_type" AS ENUM('user', 'admin', 'system')
        `);
    await queryRunner.query(`
            CREATE TABLE "listing_history" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "listing_id" uuid NOT NULL,
                "event" "public"."listing_history_event" NOT NULL,
                "old_status" "public"."listing_status",
                "new_status" "public"."listing_status",
                "old_monthly_rent_birr" integer,
                "new_monthly_rent_birr" integer,
                "old_available_from" date,
                "new_available_from" date,
                "close_reason" "public"."listing_close_reason",
                "staff_reason_code" "public"."staff_reason_code",
                "actor_type" "public"."actor_type" NOT NULL,
                "actor_id" uuid,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_listing_history_actor" CHECK (("actor_type" = 'system') = ("actor_id" IS NULL)),
                CONSTRAINT "CHK_listing_history_monthly_rent_birr" CHECK (
                    "old_monthly_rent_birr" > 0
                    AND "new_monthly_rent_birr" > 0
                ),
                CONSTRAINT "CHK_listing_history_reasons" CHECK (
                    "event" = 'status'
                    OR (
                        "close_reason" IS NULL
                        AND "staff_reason_code" IS NULL
                    )
                ),
                CONSTRAINT "CHK_listing_history_event_fields" CHECK (
                    (
                        "event" = 'status'
                        AND "new_status" IS NOT NULL
                        AND "old_monthly_rent_birr" IS NULL
                        AND "new_monthly_rent_birr" IS NULL
                        AND "old_available_from" IS NULL
                        AND "new_available_from" IS NULL
                    )
                    OR (
                        "event" = 'monthly_rent'
                        AND "old_monthly_rent_birr" IS NOT NULL
                        AND "new_monthly_rent_birr" IS NOT NULL
                        AND "old_status" IS NULL
                        AND "new_status" IS NULL
                        AND "old_available_from" IS NULL
                        AND "new_available_from" IS NULL
                    )
                    OR (
                        "event" = 'available_from'
                        AND "old_available_from" IS NOT NULL
                        AND "new_available_from" IS NOT NULL
                        AND "old_status" IS NULL
                        AND "new_status" IS NULL
                        AND "old_monthly_rent_birr" IS NULL
                        AND "new_monthly_rent_birr" IS NULL
                    )
                ),
                CONSTRAINT "PK_d2b32ec93837ae4a12464b23144" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_listing_history_listing_id_created_at" ON "listing_history" ("listing_id", "created_at")
        `);
    await queryRunner.query(`
            ALTER TABLE "properties"
            ADD CONSTRAINT "FK_properties_lister_id" FOREIGN KEY ("lister_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "properties"
            ADD CONSTRAINT "FK_properties_neighbourhood_id" FOREIGN KEY ("neighbourhood_id") REFERENCES "neighbourhoods"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "listings"
            ADD CONSTRAINT "FK_listings_property_id" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "listings"
            ADD CONSTRAINT "FK_listings_reviewed_by_admin_id" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admin_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "listing_history"
            ADD CONSTRAINT "FK_listing_history_listing_id" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
    // Hand-added (L10): at most one open listing per property. Closed ones (rented, removed,
    // rejected) don't count, so a property keeps its history and can be relisted. Also serves
    // "the open listing of this property".
    await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_listings_one_open_per_property" ON "listings" ("property_id")
            WHERE "status" IN ('draft', 'pending_review', 'live', 'stale', 'expired')
        `);
    // Hand-added: history rows are never changed. DELETE stays allowed, for deleting a draft with
    // its history (the foreign key cascades).
    await queryRunner.query(`
            CREATE FUNCTION "listing_history_no_update"() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'listing_history rows are never changed (UPDATE is not allowed)'
                USING ERRCODE = 'insufficient_privilege';
            END
            $$
        `);
    await queryRunner.query(`
            CREATE TRIGGER "listing_history_no_update"
            BEFORE UPDATE ON "listing_history"
            FOR EACH ROW EXECUTE FUNCTION "listing_history_no_update"()
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP TRIGGER "listing_history_no_update" ON "listing_history"
        `);
    await queryRunner.query(`
            DROP FUNCTION "listing_history_no_update"()
        `);
    await queryRunner.query(`
            DROP INDEX "public"."UQ_listings_one_open_per_property"
        `);
    await queryRunner.query(`
            ALTER TABLE "listing_history" DROP CONSTRAINT "FK_listing_history_listing_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "listings" DROP CONSTRAINT "FK_listings_reviewed_by_admin_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "listings" DROP CONSTRAINT "FK_listings_property_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "properties" DROP CONSTRAINT "FK_properties_neighbourhood_id"
        `);
    await queryRunner.query(`
            ALTER TABLE "properties" DROP CONSTRAINT "FK_properties_lister_id"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_listing_history_listing_id_created_at"
        `);
    await queryRunner.query(`
            DROP TABLE "listing_history"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."actor_type"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."listing_history_event"
        `);
    await queryRunner.query(`
            DROP TABLE "listings"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."staff_reason_code"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."listing_close_reason"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."listing_status"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_properties_approx_location"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_properties_lister_id"
        `);
    await queryRunner.query(`
            DROP TABLE "properties"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."lister_relation"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."amenity"
        `);
    await queryRunner.query(`
            DROP TYPE "public"."property_type"
        `);
  }
}
