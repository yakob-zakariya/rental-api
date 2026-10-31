import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { MAX_DETAIL_LENGTH } from '../admin/audit/audit-details.js';

export class BanUserDto {
  @ApiProperty({
    description:
      'Why (stored on the ban and in the audit log). Never put ID numbers here.',
  })
  @IsString()
  // Also stored in banned_identities.reason (varchar 255).
  @Length(1, 255)
  reason: string;
}

export class UnbanUserDto {
  @ApiProperty({
    description: 'Why the ban is lifted. Never put ID numbers here.',
  })
  @IsString()
  @Length(1, MAX_DETAIL_LENGTH)
  note: string;
}

export class BanResultDto {
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty() status: string;
  @ApiProperty({
    description: 'Identifiers newly added to banned_identities by this ban.',
  })
  identitiesBanned: number;
}

class ActiveBanDto {
  @ApiProperty() kind: string;
  @ApiProperty() reason: string;
  @ApiProperty() bannedAt: string;
}

class UserAttemptDto {
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
  @ApiProperty() kind: string;
  @ApiProperty() isApproved: boolean;
}

export class AdminUserDetailDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() phone: string;
  @ApiProperty() status: string;
  @ApiProperty() verificationStatus: string;
  @ApiProperty({ type: String, nullable: true }) verifiedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) fullName: string | null;
  @ApiProperty({ type: String, nullable: true }) dateOfBirth: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty({
    type: [IdentityKindDto],
    description: 'Kinds only; hashes and numbers are never shown.',
  })
  identities: IdentityKindDto[];
  @ApiProperty({
    type: [ActiveBanDto],
    description: 'Active bans from this user (kinds only).',
  })
  activeBans: ActiveBanDto[];
  @ApiProperty({ type: [UserAttemptDto], description: 'Newest first.' })
  attempts: UserAttemptDto[];
}
