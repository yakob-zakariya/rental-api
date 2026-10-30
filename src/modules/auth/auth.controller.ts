import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OtpRequestIpLimit } from '../../common/throttling.js';
import { RequestOtpDto, RequestOtpResponseDto } from './dto/request-otp.dto.js';
import { OtpService } from './otp.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly otp: OtpService) {}

  /** Sends a sign-in code by SMS. Same response whether or not the phone has an account. */
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @OtpRequestIpLimit()
  @ApiOkResponse({ type: RequestOtpResponseDto })
  requestOtp(@Body() body: RequestOtpDto): Promise<RequestOtpResponseDto> {
    return this.otp.request(body.phone);
  }
}
