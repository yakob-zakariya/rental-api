import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AdminController } from '../admin/admin-controller.decorator.js';
import { AdminRole } from '../admin/admin.enums.js';
import { AdminUser } from '../admin/admin-user.entity.js';
import { CurrentAdmin } from '../admin/current-admin.decorator.js';
import { Roles } from '../admin/roles.decorator.js';
import {
  AdminUserDetailDto,
  BanResultDto,
  BanUserDto,
  UnbanUserDto,
} from './user-moderation.dto.js';
import { UserModerationService } from './user-moderation.service.js';

// A malformed id can't name a user: same 404 as an unknown one.
const userId = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException({ code: 'USER_NOT_FOUND' }),
});

@AdminController('users')
export class UserModerationController {
  constructor(private readonly moderation: UserModerationService) {}

  /** One user, for staff to check before acting (any staff role). */
  @Get(':userId')
  @ApiOkResponse({ type: AdminUserDetailDto })
  detail(@Param('userId', userId) id: string): Promise<AdminUserDetailDto> {
    return this.moderation.detail(id);
  }

  /** S5. Errors: 404 USER_NOT_FOUND, 409 ALREADY_BANNED. */
  @Post(':userId/ban')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: BanResultDto })
  ban(
    @CurrentAdmin() admin: AdminUser,
    @Param('userId', userId) id: string,
    @Body() body: BanUserDto,
  ): Promise<BanResultDto> {
    return this.moderation.ban(admin.id, id, body.reason);
  }

  /** S5, super_admin only. Errors: 404 USER_NOT_FOUND, 409 NOT_BANNED. */
  @Post(':userId/unban')
  @Roles(AdminRole.SuperAdmin)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminUserDetailDto })
  unban(
    @CurrentAdmin() admin: AdminUser,
    @Param('userId', userId) id: string,
    @Body() body: UnbanUserDto,
  ): Promise<AdminUserDetailDto> {
    return this.moderation.unban(admin.id, id, body.note);
  }
}
