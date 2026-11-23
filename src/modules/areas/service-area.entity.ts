import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Where listings may be placed (spec G1): the city boundary, one row per city. A listing's pin
 * must be inside it. Loaded by a migration from OpenStreetMap; a new boundary is a new migration.
 */
@Entity('service_area')
@Unique('UQ_service_area_city', ['city'])
export class ServiceArea {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  city: string;

  // Never selected by the app: checks run in SQL (ServiceAreaService).
  @Column({
    type: 'geography',
    spatialFeatureType: 'MultiPolygon',
    srid: 4326,
    select: false,
  })
  boundary: string;

  /** Where the boundary came from, with its version and licence. */
  @Column({ type: 'varchar', length: 255 })
  source: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
