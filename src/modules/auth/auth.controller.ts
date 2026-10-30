import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { OtpRequestIpLimit } from '../../common/throttling.js';
import { UserStatus } from '../users/user.enums.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RequestOtpDto, RequestOtpResponseDto } from './dto/request-otp.dto.js';
import { TokenPairDto } from './dto/token-pair.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { OtpService } from './otp.service.js';
import { accountUnavailable, TokenService } from './token.service.js';

@ApiTags('auth')
// Sign-in and token endpoints work without an access token.
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  /** Sends a sign-in code by SMS. Same response whether or not the phone has an account. */
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @OtpRequestIpLimit()
  @ApiOkResponse({ type: RequestOtpResponseDto })
  requestOtp(@Body() body: RequestOtpDto): Promise<RequestOtpResponseDto> {
    return this.otp.request(body.phone);
  }

  /** Signs in with the SMS code, creating the account on first use. */
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TokenPairDto })
  async verifyOtp(@Body() body: VerifyOtpDto): Promise<TokenPairDto> {
    const user = await this.otp.verify(body.phone, body.code);
    // Rule A6: suspended and banned users can't sign in.
    if (user.status !== UserStatus.Active) throw accountUnavailable();
    return this.tokens.issue(user, body.deviceName ?? null);
  }

  /** Rotates the refresh token: the old one is revoked and a new pair returned. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TokenPairDto })
  refresh(@Body() body: RefreshTokenDto): Promise<TokenPairDto> {
    return this.tokens.rotate(body.refreshToken);
  }

  /** Revokes the refresh token. Always 204, even for an unknown or already-revoked token. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  logout(@Body() body: RefreshTokenDto): Promise<void> {
    return this.tokens.revoke(body.refreshToken);
  }
}
