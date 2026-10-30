import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({
    example: '0911234567',
    description:
      'Ethiopian mobile number in any common form; normalised to E.164.',
  })
  @IsString()
  @MaxLength(32)
  phone: string;
}

export class RequestOtpResponseDto {
  @ApiProperty({ example: 300 })
  expiresInSeconds: number;
}
