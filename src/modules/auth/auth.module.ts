import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller.js';
import { OtpCode } from './otp-code.entity.js';
import { OtpService } from './otp.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([OtpCode])],
  controllers: [AuthController],
  providers: [OtpService],
})
export class AuthModule {}
