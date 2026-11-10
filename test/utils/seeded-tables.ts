/**
 * Tables that migrations fill with reference data (e.g. the Addis Ababa areas). resetDatabase()
 * empties every table, so global-setup.ts copies these into SEED_SCHEMA right after migrating, and
 * resetDatabase() puts that copy back. Tests can then change seeded rows (rename, deactivate)
 * without leaking the change into the next test.
 *
 * Parents before children: rows are restored in this order, so foreign keys hold.
 */
export const SEEDED_TABLES = ['sub_cities', 'neighbourhoods'] as const;

/** Not "public", so resetDatabase() never empties it. */
export const SEED_SCHEMA = 'test_seed';
