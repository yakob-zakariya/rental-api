import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AdminUser } from '../admin/admin-user.entity.js';
import { SubCity } from './sub-city.entity.js';

/**
 * A neighbourhood (sefer) within a sub-city: what a lister picks for a property (spec G1).
 * Never hard-deleted; staff deactivate it instead (spec G8).
 */
@Entity('neighbourhoods')
// One English name per sub-city, ignoring letter case, deactivated rows included (spec section 2).
// An expression index TypeORM can't describe, so it lives only in the migration.
@Index('UQ_neighbourhoods_sub_city_id_lower_name_en', { synchronize: false })
@Check(
  'CHK_neighbourhoods_names_not_blank',
  `btrim("name_en") <> '' AND btrim("name_am") <> ''`,
)
export class Neighbourhood {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'sub_city_id', type: 'uuid' })
  subCityId: string;

  @ManyToOne(() => SubCity)
  @JoinColumn({
    name: 'sub_city_id',
    foreignKeyConstraintName: 'FK_neighbourhoods_sub_city_id',
  })
  subCity?: SubCity;

  @Column({ name: 'name_en', type: 'varchar', length: 100 })
  nameEn: string;

  @Column({ name: 'name_am', type: 'varchar', length: 100 })
  nameAm: string;

  // Null for the seeded neighbourhoods.
  @Column({ name: 'created_by_admin_id', type: 'uuid', nullable: true })
  createdByAdminId: string | null;

  @ManyToOne(() => AdminUser)
  @JoinColumn({
    name: 'created_by_admin_id',
    foreignKeyConstraintName: 'FK_neighbourhoods_created_by_admin_id',
  })
  createdByAdmin?: AdminUser;

  // Null = active. Deactivated: hidden from the picker, kept by existing properties (spec G8).
  @Column({ name: 'deactivated_at', type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
