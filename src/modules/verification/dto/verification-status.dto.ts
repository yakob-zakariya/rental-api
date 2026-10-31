import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationStatus } from '../../users/user.enums.js';
import {
  VerificationReasonCode,
  type VerificationStatusView,
} from '../verification.service.js';

export class VerificationStatusDto implements VerificationStatusView {
  @ApiProperty({ enum: VerificationStatus })
  status: VerificationStatus;

  @ApiProperty({
    description:
      'POST /verification/sessions would start or resume a session now.',
  })
  canRetry: boolean;

  @ApiProperty({
    example: 2,
    description: 'New sessions left in the rolling 24 hours (V3).',
  })
  retriesLeftToday: number;

  @ApiProperty({
    description:
      'POST /verification/manual-review-request would be accepted now.',
  })
  canRequestManualReview: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-11-01T08:15:02.124Z',
    description:
      'Only when out of tries (V3 limit, nothing to resume): when the oldest attempt counted ' +
      'toward the limit leaves the 24-hour window and a new session can start. Otherwise null.',
  })
  retryAvailableAt: Date | null;

  @ApiPropertyOptional({
    enum: VerificationReasonCode,
    description:
      'Only when status is declined. Never given for blocked or manual_review.',
  })
  reasonCode?: VerificationReasonCode;
}
