import { Body, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { AdminLoginIpLimit } from '../../common/throttling.js';
import { AdminController } from './admin-controller.decorator.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminUser } from './admin-user.entity.js';
import { CurrentAdmin } from './current-admin.decorator.js';
import {
  AdminLoginDto,
  AdminLoginResponseDto,
  AdminMeDto,
} from './dto/admin-login.dto.js';

@AdminController('auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /**
   * Staff sign-in. Every failure — unknown email, wrong password, inactive account, too many
   * failed attempts for this email — is 401 INVALID_CREDENTIALS. Per-IP limit: 429 RATE_LIMITED.
   */
  @Post('login')
  @Public()
  @AdminLoginIpLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminLoginResponseDto })
  login(@Body() body: AdminLoginDto): Promise<AdminLoginResponseDto> {
    return this.auth.login(body.email, body.password);
  }

  /** The signed-in staff member. */
  @Get('me')
  @ApiOkResponse({ type: AdminMeDto })
  me(@CurrentAdmin() admin: AdminUser): AdminMeDto {
    return { id: admin.id, email: admin.email, role: admin.role };
  }
}
