import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { StartSessionResponseDto } from './dto/start-session-response.dto.js';
import { VerificationStatusDto } from './dto/verification-status.dto.js';
import { HttpExceptionWithRetryAfter } from './verification.errors.js';
import { VerificationService } from './verification.service.js';

@ApiTags('verification')
@ApiBearerAuth('app')
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /**
   * Starts identity verification, or resumes the current session. Errors: ALREADY_VERIFIED,
   * VERIFICATION_IN_REVIEW (409), VERIFICATION_UNAVAILABLE (403), VERIFICATION_RETRY_LIMIT (429),
   * VERIFICATION_PROVIDER_UNAVAILABLE (503).
   */
  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: StartSessionResponseDto })
  async startSession(
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StartSessionResponseDto> {
    try {
      return await this.verification.startSession(user.id);
    } catch (error) {
      if (
        error instanceof HttpExceptionWithRetryAfter &&
        error.retryAfterSeconds !== undefined
      ) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  /** The user's verification status and what they can do next (spec §4 flow step 6). */
  @Get('status')
  @ApiOkResponse({ type: VerificationStatusDto })
  getStatus(@CurrentUser() user: User): Promise<VerificationStatusDto> {
    return this.verification.getStatus(user.id);
  }

  /**
   * Asks staff to review the last declined attempt (spec §4 flow step 7). Only at the retry limit
   * after a Didit decline. Errors: ALREADY_VERIFIED, VERIFICATION_IN_REVIEW,
   * MANUAL_REVIEW_NOT_AVAILABLE (409), VERIFICATION_UNAVAILABLE (403).
   */
  @Post('manual-review-request')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerificationStatusDto })
  requestManualReview(
    @CurrentUser() user: User,
  ): Promise<VerificationStatusDto> {
    return this.verification.requestManualReview(user.id);
  }
}
