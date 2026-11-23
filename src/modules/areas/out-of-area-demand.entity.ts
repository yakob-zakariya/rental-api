import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Pins refused for being outside the service area, so staff can see where demand is outside the
 * city (spec G1, decided 2026-11-10). One row per ~1 km cell per day with a count. No user,
 * listing, device or exact time is stored, so a row can't be linked back to anyone.
 */
@Entity('out_of_area_demand')
@Check('CHK_out_of_area_demand_refusals', `"refusals" >= 1`)
@Check(
  'CHK_out_of_area_demand_point',
  `"lat_rounded" BETWEEN -90 AND 90 AND "lng_rounded" BETWEEN -180 AND 180`,
)
export class OutOfAreaDemand {
  /** Rounded to 0.01° (about 1.1 km). Numeric, so TypeORM returns it as a string. */
  @PrimaryColumn({
    name: 'lat_rounded',
    type: 'numeric',
    precision: 5,
    scale: 2,
    primaryKeyConstraintName: 'PK_out_of_area_demand',
  })
  latRounded: string;

  @PrimaryColumn({
    name: 'lng_rounded',
    type: 'numeric',
    precision: 6,
    scale: 2,
    primaryKeyConstraintName: 'PK_out_of_area_demand',
  })
  lngRounded: string;

  /** The Africa/Addis_Ababa date, no time. */
  @PrimaryColumn({
    type: 'date',
    primaryKeyConstraintName: 'PK_out_of_area_demand',
  })
  day: string;

  @Column({ type: 'int', default: 1 })
  refusals: number;
}
