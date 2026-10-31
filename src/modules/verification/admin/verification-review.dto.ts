import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_DETAIL_LENGTH } from '../../admin/audit/audit-details.js';
import { IdentityKind, VerificationOutcome } from '../verification.enums.js';
import { VerificationReasonCode } from '../verification.service.js';

export const DEFAULT_QUEUE_PAGE = 50;
export const MAX_QUEUE_PAGE = 200;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value;

export class VerificationQueueQuery {
  @ApiPropertyOptional({
    description: 'Comma-separated outcomes. Default: manual_review,blocked',
    example: 'manual_review,blocked',
  })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(VerificationOutcome, { each: true })
  status?: VerificationOutcome[];

  @ApiPropertyOptional({ description: 'Only flagged attempts' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  flagged?: boolean;

  @ApiPropertyOptional({
    description: 'Include attempts staff already decided (default false)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeDecided?: boolean;

  @ApiPropertyOptional({ default: DEFAULT_QUEUE_PAGE, maximum: MAX_QUEUE_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_QUEUE_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page.' })
  @IsOptional()
  @IsString()
  after?: string;
}

/** S4. The idNumber is hashed at once and never stored, logged or echoed (hard rule 1). */
export class ApproveVerificationDto {
  @ApiProperty({
    description: 'Why this is approved. Never put ID numbers here.',
  })
  @IsString()
  @Length(1, MAX_DETAIL_LENGTH)
  note: string;

  @ApiPropertyOptional({
    enum: IdentityKind,
    description: 'With idNumber, only when Didit returned no identifier (V8).',
  })
  @IsOptional()
  @IsEnum(IdentityKind)
  documentType?: IdentityKind;

  @ApiPropertyOptional({
    description: 'Read from the Didit console. Hashed immediately.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idNumber?: string;

  @ApiPropertyOptional({
    example: 'ETH',
    description: 'ISO 3166-1 alpha-3; passports only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  issuingCountry?: string;

  @ApiPropertyOptional({
    example: '1990-05-17',
    description: 'Corrects the effective date of birth.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'Corrects the effective name.' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;
}

/** Codes staff may decline with; the user sees them as reasonCode (user-safe). */
export const STAFF_DECLINE_REASONS = [
  VerificationReasonCode.PhotoUnclear,
  VerificationReasonCode.DocumentExpired,
  VerificationReasonCode.DocumentNotAccepted,
  VerificationReasonCode.DocumentNotVerified,
  VerificationReasonCode.Underage,
] as const;

export class DeclineVerificationDto {
  @ApiProperty({ enum: STAFF_DECLINE_REASONS })
  @IsIn(STAFF_DECLINE_REASONS)
  reasonCode: (typeof STAFF_DECLINE_REASONS)[number];

  @ApiProperty({
    description: 'Why this is declined. Never put ID numbers here.',
  })
  @IsString()
  @Length(1, MAX_DETAIL_LENGTH)
  note: string;
}

class QueueUserDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() phone: string;
  @ApiProperty() status: string;
  @ApiProperty() verificationStatus: string;
}

export class QueueItemDto {
  @ApiProperty({ format: 'uuid' }) attemptId: string;
  @ApiProperty({ enum: VerificationOutcome }) outcome: string;
  @ApiProperty() providerStatus: string;
  @ApiProperty({
    description: 'Open this session in the Didit console to see the images.',
  })
  providerSessionId: string;
  @ApiProperty({ type: String, nullable: true }) flagReason: string | null;
  @ApiProperty({ type: String, nullable: true }) declineReason: string | null;
  @ApiProperty({ type: String, nullable: true }) manualReviewRequestedAt:
    string | null;
  @ApiProperty({ type: String, nullable: true }) documentType: string | null;
  @ApiProperty({ type: String, nullable: true }) verifiedName: string | null;
  @ApiProperty({ type: String, nullable: true }) dateOfBirth: string | null;
  @ApiProperty() decided: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty({ type: QueueUserDto }) user: QueueUserDto;
}

export class QueuePageDto {
  @ApiProperty({ type: [QueueItemDto] }) items: QueueItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
}

class HistoryItemDto {
  @ApiProperty({ format: 'uuid' }) attemptId: string;
  @ApiProperty() outcome: string;
  @ApiProperty() providerStatus: string;
  @ApiProperty({ type: String, nullable: true }) declineReason: string | null;
  @ApiProperty({ type: String, nullable: true }) flagReason: string | null;
  @ApiProperty() decided: boolean;
  @ApiProperty() createdAt: string;
  @ApiProperty({ type: String, nullable: true }) completedAt: string | null;
}

class IdentityKindDto {
  @ApiProperty({ enum: IdentityKind }) kind: string;
  @ApiProperty() isApproved: boolean;
}

export class VerificationDetailDto extends QueueItemDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Exactly what Didit returned.',
  })
  providerVerifiedName: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Exactly what Didit returned.',
  })
  providerDateOfBirth: string | null;
  @ApiProperty({
    type: [IdentityKindDto],
    description: 'Kinds only; hashes and numbers are never shown.',
  })
  identities: IdentityKindDto[];
  @ApiProperty({
    type: [HistoryItemDto],
    description: "The user's attempts, newest first.",
  })
  history: HistoryItemDto[];
}
