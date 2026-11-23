import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CharLength, IsCalendarDate } from '../../../common/validators.js';
import { LISTING_LIMITS, TEXT_LIMITS } from '../listing-limits.js';
import {
  Amenity,
  CloseReason,
  ListerRelation,
  ListingStatus,
  PropertyType,
  StaffReasonCode,
} from '../listings.enums.js';

// Text is trimmed before its length is checked, so "   " is too short.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const upTo = (field: keyof typeof LISTING_LIMITS) =>
  `At most ${LISTING_LIMITS[field].max} (above: 400 ${LISTING_LIMITS[field].code})`;

export class LatLngDto {
  @ApiProperty({ example: 9.0102, minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ example: 38.7606, minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng: number;
}

/**
 * The fields of a listing and its property, for POST /listings and PATCH /listings/:id. Every
 * field is optional: a draft may be half-filled (decided 2026-11-23), and submitting checks
 * completeness (L2). In a PATCH, a missing field is left as it is and `null` clears it
 * (`amenities: []` clears the amenities).
 */
export class ListingFieldsDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'From GET /areas. If the real one is not listed: the nearest one, plus unlistedNeighbourhoodName',
  })
  @IsOptional()
  @IsUUID()
  neighbourhoodId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TEXT_LIMITS.unlistedNeighbourhoodName,
    description:
      '"My neighbourhood isn\'t listed": the real name (G1). Never shown publicly',
  })
  @IsOptional()
  @Transform(trim)
  @CharLength(1, TEXT_LIMITS.unlistedNeighbourhoodName)
  unlistedNeighbourhoodName?: string | null;

  @ApiPropertyOptional({ enum: PropertyType, nullable: true })
  @IsOptional()
  @IsEnum(PropertyType)
  type?: PropertyType | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    description: upTo('bedrooms'),
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  bedrooms?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    description: `0 = shared bathroom. ${upTo('bathrooms')}`,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  bathrooms?: number | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  furnished?: boolean | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  separateWaterMeter?: boolean | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  separateElectricityMeter?: boolean | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: `Optional, even to submit. ${upTo('sizeM2')}`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  sizeM2?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    description: `0 = ground floor. Optional, even to submit. ${upTo('floor')}`,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  floor?: number | null;

  @ApiPropertyOptional({
    enum: Amenity,
    isArray: true,
    description: 'No duplicates; [] for none',
  })
  // null is refused: [] means none.
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsEnum(Amenity, { each: true })
  amenities?: Amenity[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TEXT_LIMITS.description,
  })
  @IsOptional()
  @Transform(trim)
  @CharLength(1, TEXT_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({
    type: LatLngDto,
    nullable: true,
    description:
      'The exact point, inside Addis Ababa (else 400 LOCATION_OUTSIDE_SERVICE_AREA). Only you and staff see it',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => LatLngDto)
  location?: LatLngDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TEXT_LIMITS.landmark,
    description: 'Private, like the exact point',
  })
  @IsOptional()
  @Transform(trim)
  @CharLength(1, TEXT_LIMITS.landmark)
  landmark?: string | null;

  @ApiPropertyOptional({ enum: ListerRelation, nullable: true })
  @IsOptional()
  @IsEnum(ListerRelation)
  listerRelation?: ListerRelation | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: `Whole birr. ${upTo('monthlyRentBirr')}`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyRentBirr?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  advanceMonths?: number | null;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  negotiable?: boolean | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-12-01',
    description:
      'Not before today in Addis Ababa when set or changed (400 AVAILABLE_FROM_IN_PAST)',
  })
  @IsOptional()
  @IsCalendarDate()
  availableFrom?: string | null;
}

// --- Responses ---

export class AreaRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Bole' }) nameEn: string;
  @ApiProperty({ example: 'ቦሌ' }) nameAm: string;
}

export class NeighbourhoodRefDto extends AreaRefDto {
  @ApiProperty({
    description:
      'False if staff deactivated it: the property keeps it, but it cannot be newly picked',
  })
  active: boolean;
}

/** The lister's own view of the property: everything, including the private fields (G3). */
export class MyPropertyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: NeighbourhoodRefDto, nullable: true })
  neighbourhood: NeighbourhoodRefDto | null;
  @ApiProperty({ type: AreaRefDto, nullable: true }) subCity: AreaRefDto | null;
  @ApiProperty({ type: String, nullable: true })
  unlistedNeighbourhoodName: string | null;
  @ApiProperty({ enum: PropertyType, nullable: true })
  type: PropertyType | null;
  @ApiProperty({ type: Number, nullable: true }) bedrooms: number | null;
  @ApiProperty({ type: Number, nullable: true }) bathrooms: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) furnished: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true })
  separateWaterMeter: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true })
  separateElectricityMeter: boolean | null;
  @ApiProperty({ type: Number, nullable: true }) sizeM2: number | null;
  @ApiProperty({ type: Number, nullable: true }) floor: number | null;
  @ApiProperty({ enum: Amenity, isArray: true }) amenities: Amenity[];
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ type: LatLngDto, nullable: true }) location: LatLngDto | null;
  @ApiProperty({
    type: LatLngDto,
    nullable: true,
    description: 'The point the public sees: the exact one moved 200–400 m',
  })
  approxLocation: LatLngDto | null;
  @ApiProperty({ type: String, nullable: true }) landmark: string | null;
  @ApiProperty({ enum: ListerRelation, nullable: true })
  listerRelation: ListerRelation | null;
}

/** A listing as its lister sees it (GET /me/listings, and the answer to every change). */
export class MyListingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ListingStatus }) status: ListingStatus;
  @ApiProperty({ description: 'Goes up by 1 on every change' })
  version: number;
  @ApiProperty({
    type: [String],
    example: ['monthlyRentBirr', 'location'],
    description:
      'Fields still needed before submitting (photos are counted separately)',
  })
  missing: string[];
  @ApiProperty({ type: Number, nullable: true })
  monthlyRentBirr: number | null;
  @ApiProperty({ type: Number, nullable: true }) advanceMonths: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) negotiable: boolean | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  availableFrom: string | null;
  @ApiProperty({ enum: CloseReason, nullable: true })
  closeReason: CloseReason | null;
  @ApiProperty({
    enum: StaffReasonCode,
    nullable: true,
    description: 'The last rejection or takedown reason',
  })
  staffReasonCode: StaffReasonCode | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Staff's note with that decision",
  })
  listerNote: string | null;
  @ApiProperty({ type: MyPropertyDto }) property: MyPropertyDto;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: Date, nullable: true }) submittedAt: Date | null;
  @ApiProperty({ type: Date, nullable: true }) publishedAt: Date | null;
  @ApiProperty({ type: Date, nullable: true }) closedAt: Date | null;
}
