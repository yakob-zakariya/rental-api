import { ApiProperty } from '@nestjs/swagger';
import type { StartedSession } from '../verification.service.js';

export class StartSessionResponseDto implements StartedSession {
  @ApiProperty({ example: 'https://verify.didit.me/session/3FaJ9wLqX2Mz' })
  verificationUrl: string;

  @ApiProperty({ description: 'For the Didit SDK. A secret: never log it.' })
  sessionToken: string;
}
