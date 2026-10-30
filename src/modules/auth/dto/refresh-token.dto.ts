import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** Body of POST /auth/refresh and POST /auth/logout. */
export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(2048)
  refreshToken: string;
}
