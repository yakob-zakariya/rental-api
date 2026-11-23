import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Point,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Neighbourhood } from '../areas/neighbourhood.entity.js';
import { User } from '../users/user.entity.js';
import { Amenity, ListerRelation, PropertyType } from './listings.enums.js';

/**
 * The physical home (spec section 2). A property outlives its listings: relisting adds a new
 * listing to the same property (L11).
 *
 * A draft may be saved half-filled (decided 2026-11-23), so the fields a lister must fill in
 * before submitting are nullable here; submitting checks them (L2, LISTING_INCOMPLETE). Null on
 * a yes/no field means "not answered yet", never "no".
 */
@Entity('properties')
// "Not blank" is `~ '\S'` (at least one non-whitespace character): btrim() strips only spaces.
@Check('CHK_properties_bedrooms', `"bedrooms" >= 0`)
// 0 = shared bathroom (the app shows "Shared bathroom").
@Check('CHK_properties_bathrooms', `"bathrooms" >= 0`)
@Check('CHK_properties_size_m2', `"size_m2" > 0`)
// 0 = ground floor.
@Check('CHK_properties_floor', `"floor" >= 0`)
@Check(
  'CHK_properties_description',
  `"description" ~ '\\S' AND char_length("description") <= 2000`,
)
@Check(
  'CHK_properties_unlisted_neighbourhood_name',
  `"unlisted_neighbourhood_name" ~ '\\S'`,
)
@Check('CHK_properties_landmark', `"landmark" ~ '\\S'`)
// The approximate point is made from the exact one (G2), so they're set and cleared together.
@Check(
  'CHK_properties_location_pair',
  `("location" IS NULL) = ("approx_location" IS NULL)`,
)
export class Property {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_properties_lister_id')
  @Column({ name: 'lister_id', type: 'uuid' })
  listerId: string;

  @ManyToOne(() => User)
  @JoinColumn({
    name: 'lister_id',
    foreignKeyConstraintName: 'FK_properties_lister_id',
  })
  lister?: User;

  // The sub-city follows from it. If the real one isn't in our list: the nearest one (G1).
  @Column({ name: 'neighbourhood_id', type: 'uuid', nullable: true })
  neighbourhoodId: string | null;

  @ManyToOne(() => Neighbourhood)
  @JoinColumn({
    name: 'neighbourhood_id',
    foreignKeyConstraintName: 'FK_properties_neighbourhood_id',
  })
  neighbourhood?: Neighbourhood;

  /** The real name, typed by the lister when it isn't in our list (G1). Never public. */
  @Column({
    name: 'unlisted_neighbourhood_name',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  unlistedNeighbourhoodName: string | null;

  @Column({
    type: 'enum',
    enum: PropertyType,
    enumName: 'property_type',
    nullable: true,
  })
  type: PropertyType | null;

  @Column({ type: 'int', nullable: true })
  bedrooms: number | null;

  @Column({ type: 'int', nullable: true })
  bathrooms: number | null;

  @Column({ type: 'boolean', nullable: true })
  furnished: boolean | null;

  @Column({ name: 'separate_water_meter', type: 'boolean', nullable: true })
  separateWaterMeter: boolean | null;

  @Column({
    name: 'separate_electricity_meter',
    type: 'boolean',
    nullable: true,
  })
  separateElectricityMeter: boolean | null;

  /** Optional, even to submit. */
  @Column({ name: 'size_m2', type: 'int', nullable: true })
  sizeM2: number | null;

  /** Optional, even to submit. */
  @Column({ type: 'int', nullable: true })
  floor: number | null;

  // No duplicates: the request DTO refuses them (T2.2). Empty = none.
  @Column({
    type: 'enum',
    enum: Amenity,
    enumName: 'amenity',
    array: true,
    default: '{}',
  })
  amenities: Amenity[];

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // Private (G3): only the lister and staff see it; never searched (G4). `select: false` keeps it
  // out of every query that doesn't ask for it by name.
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
    select: false,
  })
  location: Point | null;

  /** The exact point moved 200–400 m, made once when the location is set (G2). Public. */
  @Index('IDX_properties_approx_location', { spatial: true })
  @Column({
    name: 'approx_location',
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  approxLocation: Point | null;

  // Private, like `location` (G3).
  @Column({ type: 'varchar', length: 200, nullable: true, select: false })
  landmark: string | null;

  @Column({
    name: 'lister_relation',
    type: 'enum',
    enum: ListerRelation,
    enumName: 'lister_relation',
    nullable: true,
  })
  listerRelation: ListerRelation | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
