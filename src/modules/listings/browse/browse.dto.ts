import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AreaRefDto, LatLngDto } from '../dto/listing.dto.js';
import { LISTING_LIMITS } from '../listing-limits.js';
import { Amenity, PropertyType } from '../listings.enums.js';
import { BROWSE_SORTS, type BrowseSort } from './browse-cursor.js';

export const DEFAULT_BROWSE_PAGE = 20;
export const MAX_BROWSE_PAGE = 50;
/** "Near me" without radiusKm (decided 2026-11-24). */
export const DEFAULT_RADIUS_KM = 5;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const MAX_RENT = LISTING_LIMITS.monthlyRentBirr.max;

/** GET /listings (G5): every filter optional and combinable. */
export class BrowseQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'From GET /areas' })
  @IsOptional()
  @IsUUID()
  subCityId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'From GET /areas' })
  @IsOptional()
  @IsUUID()
  neighbourhoodId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_RENT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RENT)
  minRent?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_RENT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RENT)
  maxRent?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description:
      'At most this many months of rent in advance (decided 2026-11-24)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  maxAdvanceMonths?: number;

  @ApiPropertyOptional({ enum: PropertyType })
  @IsOptional()
  @IsEnum(PropertyType)
  type?: PropertyType;

  @ApiPropertyOptional({ minimum: 0, maximum: LISTING_LIMITS.bedrooms.max })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LISTING_LIMITS.bedrooms.max)
  minBedrooms?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  furnished?: boolean;

  @ApiPropertyOptional({
    minimum: -90,
    maximum: 90,
    description: 'Near me: with lng',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({
    minimum: -180,
    maximum: 180,
    description: 'Near me: with lat',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional({
    default: DEFAULT_RADIUS_KM,
    description:
      'Near me, in km (at most SEARCH_MAX_RADIUS_KM, 20); measured from the approximate point',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  radiusKm?: number;

  @ApiPropertyOptional({
    enum: BROWSE_SORTS,
    default: 'newest',
    description: 'distance needs lat and lng',
  })
  @IsOptional()
  @IsIn(BROWSE_SORTS)
  sort?: BrowseSort;

  @ApiPropertyOptional({
    default: DEFAULT_BROWSE_PAGE,
    maximum: MAX_BROWSE_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BROWSE_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

export class CoverPhotoDto {
  @ApiProperty({
    description:
      'Public URL of the 480 px thumbnail (cards never load the full photo)',
  })
  thumbnailUrl: string;
  @ApiProperty({
    description: 'Of the full photo; the thumbnail has the same proportions',
  })
  width: number;
  @ApiProperty() height: number;
}

/** A browse card (G5): never the exact point, the landmark, the typed neighbourhood or the lister. */
export class BrowseCardDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() monthlyRentBirr: number;
  @ApiProperty() advanceMonths: number;
  @ApiProperty() negotiable: boolean;
  @ApiProperty({
    format: 'date',
    description: 'A past date means available now',
  })
  availableFrom: string;
  @ApiProperty() publishedAt: Date;
  @ApiProperty({ enum: PropertyType }) type: PropertyType;
  @ApiProperty() bedrooms: number;
  @ApiProperty({ description: '0 = shared bathroom' }) bathrooms: number;
  @ApiProperty() furnished: boolean;
  @ApiProperty({ type: Number, nullable: true }) sizeM2: number | null;
  @ApiProperty({ type: Number, nullable: true }) floor: number | null;
  @ApiProperty({ enum: Amenity, isArray: true }) amenities: Amenity[];
  @ApiProperty({ type: AreaRefDto }) subCity: AreaRefDto;
  @ApiProperty({ type: AreaRefDto }) neighbourhood: AreaRefDto;
  @ApiProperty({
    type: LatLngDto,
    description:
      'The approximate point (200–400 m from the home): draw a circle of about 500 m, never a pin',
  })
  approxLocation: LatLngDto;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Near me only: from the approximate point, rounded to 100 m (G4)',
  })
  distanceMetres: number | null;
  @ApiProperty() photoCount: number;
  @ApiProperty({
    type: CoverPhotoDto,
    nullable: true,
    description:
      'The first photo. A live listing always has at least 3 (L2, P4), so in practice never null',
  })
  cover: CoverPhotoDto | null;
}

export class BrowsePageDto {
  @ApiProperty({ type: [BrowseCardDto] }) items: BrowseCardDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
}
