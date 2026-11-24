import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MAX_DETAIL_LENGTH } from '../../admin/audit/audit-details.js';
import { LatLngDto, PhotoDto } from '../dto/listing.dto.js';
import {
  ActorType,
  Amenity,
  CloseReason,
  ListerRelation,
  ListingHistoryEvent,
  ListingStatus,
  PropertyType,
  StaffReasonCode,
} from '../listings.enums.js';
import { UserStatus, VerificationStatus } from '../../users/user.enums.js';

export const DEFAULT_LISTING_QUEUE_PAGE = 50;
export const MAX_LISTING_QUEUE_PAGE = 200;

/** Drafts are unfinished and private: never listed for staff (decided 2026-11-24). */
export const STAFF_LISTABLE_STATUSES = Object.values(ListingStatus).filter(
  (status) => status !== ListingStatus.Draft,
);

export class AdminListingQuery {
  @ApiPropertyOptional({
    enum: STAFF_LISTABLE_STATUSES,
    default: ListingStatus.PendingReview,
  })
  @IsOptional()
  @IsIn(STAFF_LISTABLE_STATUSES)
  status?: ListingStatus;

  @ApiPropertyOptional({
    default: DEFAULT_LISTING_QUEUE_PAGE,
    maximum: MAX_LISTING_QUEUE_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_QUEUE_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

export class RevealListerPhoneDto {
  @ApiPropertyOptional({
    description: 'Why (stored in the audit log). Never put ID numbers here.',
  })
  @IsOptional()
  @IsString()
  @Length(1, MAX_DETAIL_LENGTH)
  note?: string;
}

export class RevealedPhoneDto {
  @ApiProperty({ example: '+251911234567' }) phone: string;
}

export class ReviewFlagDto {
  @ApiProperty({
    enum: ['MANY_ACTIVE_LISTINGS', 'UNLISTED_NEIGHBOURHOOD', 'CONTACT_IN_TEXT'],
    description: 'PHOTO_MATCH comes with photo hashing (T3.3)',
  })
  code: string;
  @ApiPropertyOptional({ description: 'MANY_ACTIVE_LISTINGS' })
  activeListings?: number;
  @ApiPropertyOptional({
    description: 'UNLISTED_NEIGHBOURHOOD: the typed name',
  })
  name?: string;
  @ApiPropertyOptional({
    description:
      'CONTACT_IN_TEXT: per field (description, landmark, unlistedNeighbourhoodName), the kinds found (phone, telegram, email, url)',
    example: [{ field: 'description', kinds: ['phone', 'telegram'] }],
  })
  found?: { field: string; kinds: string[] }[];
}

class AreaNamesDto {
  @ApiProperty({ type: String, nullable: true }) subCityNameEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  neighbourhoodNameEn: string | null;
}

export class AdminQueueItemDto extends AreaNamesDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ListingStatus }) status: ListingStatus;
  @ApiProperty() version: number;
  @ApiProperty({ type: Date, nullable: true }) submittedAt: Date | null;
  @ApiProperty({ enum: PropertyType, nullable: true })
  type: PropertyType | null;
  @ApiProperty({ type: Number, nullable: true }) bedrooms: number | null;
  @ApiProperty({ type: Number, nullable: true })
  monthlyRentBirr: number | null;
  @ApiProperty() photoCount: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Signed link to the first photo (15 minutes)',
  })
  coverUrl: string | null;
  @ApiProperty({ format: 'uuid' }) listerId: string;
  @ApiProperty({ type: String, nullable: true }) listerFullName: string | null;
  @ApiProperty({ type: [ReviewFlagDto] }) flags: ReviewFlagDto[];
}

export class AdminQueuePageDto {
  @ApiProperty({ type: [AdminQueueItemDto] }) items: AdminQueueItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
}

class AdminListerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'As verified (the phone number is only shown through reveal-lister-phone)',
  })
  fullName: string | null;
  @ApiProperty({ enum: VerificationStatus })
  verificationStatus: VerificationStatus;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
}

class OtherListingDto extends AreaNamesDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ListingStatus }) status: ListingStatus;
  @ApiProperty({ type: Number, nullable: true })
  monthlyRentBirr: number | null;
  @ApiProperty({ type: Date, nullable: true }) submittedAt: Date | null;
}

class AdminHistoryDto {
  @ApiProperty({ enum: ListingHistoryEvent }) event: ListingHistoryEvent;
  @ApiProperty({ enum: ListingStatus, nullable: true })
  oldStatus: ListingStatus | null;
  @ApiProperty({ enum: ListingStatus, nullable: true })
  newStatus: ListingStatus | null;
  @ApiProperty({ type: Number, nullable: true })
  oldMonthlyRentBirr: number | null;
  @ApiProperty({ type: Number, nullable: true })
  newMonthlyRentBirr: number | null;
  @ApiProperty({ type: String, nullable: true })
  oldAvailableFrom: string | null;
  @ApiProperty({ type: String, nullable: true })
  newAvailableFrom: string | null;
  @ApiProperty({ enum: CloseReason, nullable: true })
  closeReason: CloseReason | null;
  @ApiProperty({ enum: StaffReasonCode, nullable: true })
  staffReasonCode: StaffReasonCode | null;
  @ApiProperty({ enum: ActorType }) actorType: ActorType;
  @ApiProperty({ type: String, nullable: true }) actorId: string | null;
  @ApiProperty() createdAt: Date;
}

class AdminPropertyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: String, nullable: true }) subCityNameEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  neighbourhoodId: string | null;
  @ApiProperty({ type: String, nullable: true })
  neighbourhoodNameEn: string | null;
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
  @ApiProperty({ type: LatLngDto, nullable: true, description: 'Exact (G3)' })
  location: LatLngDto | null;
  @ApiProperty({ type: LatLngDto, nullable: true, description: 'Public' })
  approxLocation: LatLngDto | null;
  @ApiProperty({ type: String, nullable: true }) landmark: string | null;
  @ApiProperty({ enum: ListerRelation, nullable: true })
  listerRelation: ListerRelation | null;
  @ApiProperty({ type: [PhotoDto] }) photos: PhotoDto[];
}

export class AdminListingDetailDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ListingStatus }) status: ListingStatus;
  @ApiProperty({ description: 'Send it with a decision (R2)' })
  version: number;
  @ApiProperty({ type: Number, nullable: true })
  monthlyRentBirr: number | null;
  @ApiProperty({ type: Number, nullable: true }) advanceMonths: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) negotiable: boolean | null;
  @ApiProperty({ type: String, nullable: true }) availableFrom: string | null;
  @ApiProperty({ type: Boolean }) needsReview: boolean;
  @ApiProperty({ enum: CloseReason, nullable: true })
  closeReason: CloseReason | null;
  @ApiProperty({ enum: StaffReasonCode, nullable: true })
  staffReasonCode: StaffReasonCode | null;
  @ApiProperty({ type: String, nullable: true }) listerNote: string | null;
  @ApiProperty({ type: Date, nullable: true }) submittedAt: Date | null;
  @ApiProperty({ type: Date, nullable: true }) publishedAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: AdminPropertyDto }) property: AdminPropertyDto;
  @ApiProperty({ type: AdminListerDto }) lister: AdminListerDto;
  @ApiProperty({ type: [OtherListingDto] }) otherListings: OtherListingDto[];
  @ApiProperty({ type: [AdminHistoryDto], description: 'Oldest first' })
  history: AdminHistoryDto[];
  @ApiProperty({ type: [ReviewFlagDto] }) flags: ReviewFlagDto[];
}
