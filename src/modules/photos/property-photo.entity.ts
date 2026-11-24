import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Property } from '../listings/property.entity.js';

/**
 * A photo of a property (spec section 2, P1): the re-encoded file in the private bucket (and,
 * while the listing is live, a copy in the public one). Photos belong to the property, so a
 * relisted listing keeps them. The perceptual hash (phash, P3) comes with T3.3.
 */
@Entity('property_photos')
@Unique('UQ_property_photos_storage_key', ['storageKey'])
// Positions are 0, 1, 2… per property. Deferred to the end of the transaction, so a reorder can
// swap positions without tripping over itself halfway.
@Unique('UQ_property_photos_property_id_position', ['propertyId', 'position'], {
  deferrable: 'INITIALLY DEFERRED',
})
@Check('CHK_property_photos_position', `"position" >= 0`)
@Check(
  'CHK_property_photos_size',
  `"width" > 0 AND "height" > 0 AND "bytes" > 0`,
)
export class PropertyPhoto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'property_id', type: 'uuid' })
  propertyId: string;

  // RESTRICT: a property's photos are deleted on purpose (rows and files together), never by a
  // cascade that would leave the files behind in storage.
  @ManyToOne(() => Property, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'property_id',
    foreignKeyConstraintName: 'FK_property_photos_property_id',
  })
  property?: Property;

  /** The key in object storage: properties/<property id>/<photo id>.jpg. */
  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey: string;

  /** Of the stored (re-encoded) file. */
  @Column({ type: 'int' })
  width: number;

  @Column({ type: 'int' })
  height: number;

  @Column({ type: 'int' })
  bytes: number;

  /** Display order, from 0; the first is the cover. */
  @Column({ type: 'int' })
  position: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
