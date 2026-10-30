import { ApiProperty } from '@nestjs/swagger';
import type { TokenPair } from '../token.service.js';

export class TokenPairDto implements TokenPair {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty({
    example: 900,
    description: 'Seconds until the access token expires.',
  })
  accessTokenExpiresIn: number;
}
