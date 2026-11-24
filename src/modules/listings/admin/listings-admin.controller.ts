import {
  Body,
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
import { listingNotFound } from '../listing-state.js';
import {
  AdminListingDetailDto,
  AdminListingQuery,
  AdminQueuePageDto,
  RevealedPhoneDto,
  RevealListerPhoneDto,
} from './listings-admin.dto.js';
import { ListingsAdminService } from './listings-admin.service.js';

const listingId = new ParseUUIDPipe({ exceptionFactory: listingNotFound });

/** Staff review of listings (spec section 8). Reads: any staff role. */
@AdminController('listings')
export class ListingsAdminController {
  constructor(private readonly listings: ListingsAdminService) {}

  /** The queue: pending_review by default, oldest submission first. Drafts are never listed. */
  @Get()
  @ApiOkResponse({ type: AdminQueuePageDto })
  queue(@Query() query: AdminListingQuery): Promise<AdminQueuePageDto> {
    return this.listings.queue(query);
  }

  /** One listing with its photos, flags, lister, other listings and history. 404 LISTING_NOT_FOUND. */
  @Get(':id')
  @ApiOkResponse({ type: AdminListingDetailDto })
  detail(@Param('id', listingId) id: string): Promise<AdminListingDetailDto> {
    return this.listings.detail(id);
  }

  /**
   * The lister's phone number, to call about a suspicious listing. Moderator and above; every
   * reveal is recorded in admin_actions (decided 2026-11-24). 404 LISTING_NOT_FOUND.
   */
  @Post(':id/reveal-lister-phone')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: RevealedPhoneDto })
  revealListerPhone(
    @CurrentAdmin() admin: AdminUser,
    @Param('id', listingId) id: string,
    @Body() body: RevealListerPhoneDto,
  ): Promise<RevealedPhoneDto> {
    return this.listings.revealListerPhone(admin.id, id, body.note);
  }
}
