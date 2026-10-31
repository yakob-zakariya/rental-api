import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { AdminRole } from '../admin.enums.js';
import type { AdminLoginResult } from '../admin-auth.service.js';

export class AdminLoginDto {
  @ApiProperty({ example: 'staff@example.com' })
  // Pasted emails often carry spaces; trim before validating (case is handled by the service).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  password: string;
}

export class AdminLoginResponseDto implements AdminLoginResult {
  @ApiProperty()
  accessToken: string;

  @ApiProperty({ example: 28800 })
  accessTokenExpiresIn: number;
}

export class AdminMeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: AdminRole })
  role: AdminRole;
}
