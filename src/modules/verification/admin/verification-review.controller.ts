import {
  Body,
  NotFoundException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AdminController } from '../../admin/admin-controller.decorator.js';
import { AdminRole } from '../../admin/admin.enums.js';
import { AdminUser } from '../../admin/admin-user.entity.js';
import { CurrentAdmin } from '../../admin/current-admin.decorator.js';
import { Roles } from '../../admin/roles.decorator.js';
import {
  ApproveVerificationDto,
  DeclineVerificationDto,
  QueuePageDto,
  VerificationDetailDto,
  VerificationQueueQuery,
} from './verification-review.dto.js';
import { VerificationReviewService } from './verification-review.service.js';

// A malformed id can't name an attempt: same 404 as an unknown one.
const attemptId = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException({ code: 'ATTEMPT_NOT_FOUND' }),
});

@AdminController('verifications')
export class VerificationReviewController {
  constructor(private readonly review: VerificationReviewService) {}

  /** The review queue, oldest first (any staff role). */
  @Get()
  @ApiOkResponse({ type: QueuePageDto })
  queue(@Query() query: VerificationQueueQuery): Promise<QueuePageDto> {
    return this.review.queue(query);
  }

  /** One attempt: Didit's values beside the effective ones, identity kinds, the user's history. */
  @Get(':attemptId')
  @ApiOkResponse({ type: VerificationDetailDto })
  detail(
    @Param('attemptId', attemptId) id: string,
  ): Promise<VerificationDetailDto> {
    return this.review.detail(id);
  }

  /** S4. Errors: 409 BANNED_IDENTITY / DUPLICATE_IDENTITY / UNDERAGE / IDENTIFIER_ALREADY_PRESENT / OTHER_BLOCKED_ATTEMPTS / ALREADY_DECIDED / ATTEMPT_NOT_REVIEWABLE, 400 MISSING_IDENTITY_DATA / INVALID_ID_NUMBER. */
  @Post(':attemptId/approve')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerificationDetailDto })
  approve(
    @CurrentAdmin() admin: AdminUser,
    @Param('attemptId', attemptId) id: string,
    @Body() body: ApproveVerificationDto,
  ): Promise<VerificationDetailDto> {
    return this.review.approve(admin.id, id, body);
  }

  /** Decline a manual_review attempt (final). Errors: 409 ALREADY_DECIDED / ATTEMPT_NOT_REVIEWABLE. */
  @Post(':attemptId/decline')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerificationDetailDto })
  decline(
    @CurrentAdmin() admin: AdminUser,
    @Param('attemptId', attemptId) id: string,
    @Body() body: DeclineVerificationDto,
  ): Promise<VerificationDetailDto> {
    return this.review.decline(admin.id, id, body);
  }
}
