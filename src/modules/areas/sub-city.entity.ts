import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A sub-city (kifle ketema). Fixed reference data: seeded by a migration, never changed by staff
 * (spec G8). `city` is "Addis Ababa" for every row at launch (product overview §6).
 */
@Entity('sub_cities')
@Unique('UQ_sub_cities_city_name_en', ['city', 'nameEn'])
@Check(
  'CHK_sub_cities_names_not_blank',
  `btrim("name_en") <> '' AND btrim("name_am") <> ''`,
)
export class SubCity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  city: string;

  @Column({ name: 'name_en', type: 'varchar', length: 100 })
  nameEn: string;

  @Column({ name: 'name_am', type: 'varchar', length: 100 })
  nameAm: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
