import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserLanguage } from '../user.enums.js';

/**
 * PATCH /me. preferredLanguage is the only editable field; anything else (fullName, dateOfBirth,
 * …) is rejected by the global pipe's forbidNonWhitelisted (V9).
 */
export class UpdateMeDto {
  @ApiProperty({ enum: UserLanguage })
  @IsEnum(UserLanguage, {
    message: 'preferredLanguage must be one of am, om, en',
  })
  preferredLanguage: UserLanguage;
}
