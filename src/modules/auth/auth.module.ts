import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller.js';
import { OtpCode } from './otp-code.entity.js';
import { OtpService } from './otp.service.js';
import { RefreshToken } from './refresh-token.entity.js';
import { TokenService } from './token.service.js';

@Module({
  // No module-wide secret: TokenService passes the access or refresh secret on every call.
  imports: [
    TypeOrmModule.forFeature([OtpCode, RefreshToken]),
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [OtpService, TokenService],
  exports: [TokenService],
})
export class AuthModule {}
