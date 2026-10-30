import { ApiProperty } from '@nestjs/swagger';
import { UserLanguage, VerificationStatus } from '../user.enums.js';

export class ProfileDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '+251911234567' })
  phone: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set by identity verification.',
  })
  fullName: string | null;

  @ApiProperty({ type: String, nullable: true, example: '1990-05-17' })
  dateOfBirth: string | null;

  @ApiProperty({ enum: UserLanguage })
  preferredLanguage: UserLanguage;

  @ApiProperty({ enum: VerificationStatus })
  verificationStatus: VerificationStatus;

  @ApiProperty({ type: Date, nullable: true })
  verifiedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
