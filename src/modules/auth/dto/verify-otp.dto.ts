import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: '0911234567' })
  @IsString()
  @MaxLength(32)
  phone: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiPropertyOptional({ example: 'Samsung A14' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}
