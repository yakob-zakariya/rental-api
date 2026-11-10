import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-written (spec section 2, T1.1): the 11 sub-cities and the starting neighbourhoods from
// docs/addis-ababa-neighbourhoods.md as reviewed on 2026-11-09, copied here once. A migration must
// give the same result every time it runs, so it never reads that file; later changes go through
// the staff endpoints (spec G8), not through this list.

const CITY = 'Addis Ababa';

const SUB_CITIES: [nameEn: string, nameAm: string][] = [
  ['Addis Ketema', 'አዲስ ከተማ'],
  ['Akaki Kality', 'አቃቂ ቃሊቲ'],
  ['Arada', 'አራዳ'],
  ['Bole', 'ቦሌ'],
  ['Gulele', 'ጉለሌ'],
  ['Kirkos', 'ቂርቆስ'],
  ['Kolfe Keranio', 'ኮልፌ ቀራንዮ'],
  ['Lemi Kura', 'ለሚ ኩራ'],
  ['Lideta', 'ልደታ'],
  ['Nifas Silk-Lafto', 'ንፋስ ስልክ ላፍቶ'],
  ['Yeka', 'የካ'],
];

const NEIGHBOURHOODS: [subCityEn: string, nameEn: string, nameAm: string][] = [
  ['Addis Ketema', 'Merkato', 'መርካቶ'],
  ['Addis Ketema', 'Autobus Tera', 'አውቶቡስ ተራ'],
  ['Addis Ketema', 'Sebategna', 'ሰባተኛ'],
  ['Addis Ketema', 'Somale Tera', 'ሶማሌ ተራ'],
  ['Addis Ketema', 'Mesalemia', 'መሳለሚያ'],
  ['Addis Ketema', 'Teklehaimanot', 'ተክለ ሃይማኖት'],
  ['Akaki Kality', 'Kality', 'ቃሊቲ'],
  ['Akaki Kality', 'Akaki', 'አቃቂ'],
  ['Akaki Kality', 'Tulu Dimtu', 'ቱሉ ዲምቱ'],
  ['Akaki Kality', 'Kilinto', 'ቂሊንጦ'],
  ['Akaki Kality', 'Saris', 'ሳሪስ'],
  ['Akaki Kality', 'Koye Feche', 'ኮዬ ፈጬ'],
  ['Arada', 'Piassa', 'ፒያሳ'],
  ['Arada', 'Arat Kilo', 'አራት ኪሎ'],
  ['Arada', 'Atikilt Tera', 'አትክልት ተራ'],
  ['Arada', 'Doro Manekia', 'ዶሮ ማነቂያ'],
  ['Bole', 'Bole Medhanialem', 'ቦሌ መድኃኔዓለም'],
  ['Bole', 'Atlas', 'አትላስ'],
  ['Bole', 'Bole Michael', 'ቦሌ ሚካኤል'],
  ['Bole', 'Bole Bulbula', 'ቦሌ ቡልቡላ'],
  ['Bole', 'Gerji', 'ገርጂ'],
  ['Bole', 'Rwanda', 'ሩዋንዳ'],
  ['Bole', 'Goro', 'ጎሮ'],
  ['Bole', 'Summit', 'ሰሚት'],
  ['Bole', 'Wollo Sefer', 'ወሎ ሰፈር'],
  ['Bole', 'Hayahulet (22)', 'ሃያ ሁለት'],
  ['Gulele', 'Shiro Meda', 'ሽሮ ሜዳ'],
  ['Gulele', 'Entoto', 'እንጦጦ'],
  ['Gulele', 'Addisu Gebeya', 'አዲሱ ገበያ'],
  ['Gulele', 'Kechene', 'ቀጨኔ'],
  ['Gulele', 'Wingate', 'ዊንጌት'],
  ['Gulele', 'Sidist Kilo', 'ስድስት ኪሎ'],
  ['Gulele', 'Gojam Berenda', 'ጎጃም በረንዳ'],
  ['Kirkos', 'Kazanchis', 'ካዛንቺስ'],
  ['Kirkos', 'Bambis', 'ባምቢስ'],
  ['Kirkos', 'Kera', 'ቄራ'],
  ['Kirkos', 'Leghar', 'ለገሃር'],
  ['Kirkos', 'Gotera', 'ጎተራ'],
  ['Kirkos', 'Olympia', 'ኦሎምፒያ'],
  ['Kolfe Keranio', 'Kolfe', 'ኮልፌ'],
  ['Kolfe Keranio', 'Keranio', 'ቀራንዮ'],
  ['Kolfe Keranio', 'Ayer Tena', 'አየር ጤና'],
  ['Kolfe Keranio', 'Alem Bank', 'ዓለም ባንክ'],
  ['Kolfe Keranio', 'Bethel', 'ቤቴል'],
  ['Kolfe Keranio', 'Asko', 'አስኮ'],
  ['Kolfe Keranio', 'Tor Hailoch', 'ጦር ኃይሎች'],
  ['Kolfe Keranio', 'Zenebework', 'ዘነበወርቅ'],
  ['Lemi Kura', 'Ayat', 'አያት'],
  ['Lemi Kura', 'Bole Arabsa', 'ቦሌ አራብሳ'],
  ['Lemi Kura', 'Yeka Abado', 'የካ አባዶ'],
  ['Lideta', 'Lideta', 'ልደታ'],
  ['Lideta', 'Abinet', 'አብነት'],
  ['Lideta', 'Coca-Cola', 'ኮካ ኮላ'],
  ['Lideta', 'Mexico', 'ሜክሲኮ'],
  ['Lideta', 'Balcha', 'ባልቻ'],
  ['Nifas Silk-Lafto', 'Sar Bet', 'ሳር ቤት'],
  ['Nifas Silk-Lafto', 'Mekanisa', 'መካኒሳ'],
  ['Nifas Silk-Lafto', 'Jemo', 'ጀሞ'],
  ['Nifas Silk-Lafto', 'Lafto', 'ላፍቶ'],
  ['Nifas Silk-Lafto', 'Haile Garment', 'ኃይሌ ጋርመንት'],
  ['Nifas Silk-Lafto', 'Gofa', 'ጎፋ'],
  ['Nifas Silk-Lafto', 'Lebu', 'ለቡ'],
  ['Yeka', 'Megenagna', 'መገናኛ'],
  ['Yeka', 'Kotebe', 'ኮተቤ'],
  ['Yeka', 'Ferensay Legasion', 'ፈረንሳይ ለጋሲዮን'],
  ['Yeka', 'Gurd Shola', 'ጉርድ ሾላ'],
  ['Yeka', 'Shola', 'ሾላ'],
  ['Yeka', 'Lamberet', 'ላምበረት'],
  ['Yeka', 'Kebena', 'ቀበና'],
  ['Yeka', 'CMC', 'ሲኤምሲ'],
];

export class SeedAddisAbabaAreas1794223388085 implements MigrationInterface {
  name = 'SeedAddisAbabaAreas1794223388085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "sub_cities" ("city", "name_en", "name_am")
       SELECT $1, name_en, name_am FROM unnest($2::varchar[], $3::varchar[]) AS t(name_en, name_am)`,
      [CITY, SUB_CITIES.map(([en]) => en), SUB_CITIES.map(([, am]) => am)],
    );

    const inserted: unknown[] = await queryRunner.query(
      `INSERT INTO "neighbourhoods" ("sub_city_id", "name_en", "name_am")
       SELECT s."id", t.name_en, t.name_am
       FROM unnest($2::varchar[], $3::varchar[], $4::varchar[]) AS t(sub_city, name_en, name_am)
       JOIN "sub_cities" s ON s."city" = $1 AND s."name_en" = t.sub_city
       RETURNING "id"`,
      [
        CITY,
        NEIGHBOURHOODS.map(([subCity]) => subCity),
        NEIGHBOURHOODS.map(([, en]) => en),
        NEIGHBOURHOODS.map(([, , am]) => am),
      ],
    );
    // A neighbourhood whose sub-city name doesn't match would be dropped silently by the join.
    if (inserted.length !== NEIGHBOURHOODS.length) {
      throw new Error(
        `Seeded ${inserted.length} of ${NEIGHBOURHOODS.length} neighbourhoods: a sub-city name doesn't match`,
      );
    }
  }

  // Removes exactly the seeded rows. Fails (foreign key) if staff have since added neighbourhoods
  // or properties use these ones, rather than deleting their data.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "neighbourhoods" n
       USING "sub_cities" s,
             unnest($2::varchar[], $3::varchar[]) AS t(sub_city, name_en)
       WHERE n."sub_city_id" = s."id" AND s."city" = $1
         AND s."name_en" = t.sub_city AND n."name_en" = t.name_en
         AND n."created_by_admin_id" IS NULL`,
      [
        CITY,
        NEIGHBOURHOODS.map(([subCity]) => subCity),
        NEIGHBOURHOODS.map(([, en]) => en),
      ],
    );
    await queryRunner.query(
      `DELETE FROM "sub_cities" WHERE "city" = $1 AND "name_en" = ANY($2::varchar[])`,
      [CITY, SUB_CITIES.map(([en]) => en)],
    );
  }
}
