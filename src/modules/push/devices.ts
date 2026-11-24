import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, Length } from 'class-validator';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthRequest } from '../../common/auth-request.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { DevicePlatform } from './device.entity.js';

/** Devices one user may have (decided 2026-11-24); an 11th replaces the least recently seen. */
export const MAX_DEVICES_PER_USER = 10;

export class RegisterDeviceDto {
  @ApiProperty({
    description:
      "This phone app's Firebase Installation ID (FID), from firebase_messaging's onRegistered",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 255)
  installationId: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}

export class RegisteredDeviceDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Keep it: DELETE /me/devices/:id on logout',
  })
  id: string;
}

const deviceNotFound = () =>
  new NotFoundException({ code: 'DEVICE_NOT_FOUND' });

/** The sign-in session of the request (the access token's `sid`). */
const SessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthRequest>().authSessionId,
);

@Injectable()
export class DevicesService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Registers this phone under the current sign-in session (N2; decided 2026-11-24). The same FID
   * again updates it; an FID registered by another user or session moves here (a shared phone).
   * At most 10 per user: the least recently seen goes. Errors: 401 ACCESS_TOKEN_EXPIRED (a token
   * from before sessions had ids: refresh and retry), UNAUTHENTICATED (the session has ended).
   */
  async register(
    userId: string,
    sessionId: string | undefined,
    body: RegisterDeviceDto,
  ) {
    if (!sessionId)
      throw new UnauthorizedException({ code: 'ACCESS_TOKEN_EXPIRED' });
    return this.dataSource.transaction(async (manager) => {
      // One registration at a time per user, so two at once can't both slip under the limit.
      await manager.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);
      const [session] = await manager.query<unknown[]>(
        `SELECT 1 FROM refresh_tokens
         WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp()
         LIMIT 1`,
        [sessionId, userId],
      );
      if (!session)
        throw new UnauthorizedException({ code: 'UNAUTHENTICATED' });

      const [device] = await manager.query<{ id: string }[]>(
        `INSERT INTO devices (user_id, session_id, installation_id, platform, last_seen_at)
         VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (installation_id) DO UPDATE SET user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id, platform = EXCLUDED.platform,
           last_seen_at = EXCLUDED.last_seen_at
         RETURNING id`,
        [userId, sessionId, body.installationId, body.platform],
      );
      await manager.query(
        `DELETE FROM devices WHERE id IN (
           SELECT id FROM devices WHERE user_id = $1
           ORDER BY last_seen_at DESC, created_at DESC OFFSET $2)`,
        [userId, MAX_DEVICES_PER_USER],
      );
      return { id: device.id };
    });
  }

  /** Removes one of the user's devices (the app calls it on logout). 404 DEVICE_NOT_FOUND. */
  async remove(userId: string, id: string): Promise<void> {
    const [, deleted] = await this.dataSource.query<[unknown[], number]>(
      `DELETE FROM devices WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (deleted === 0) throw deviceNotFound();
  }
}

/** The user's phones for push notifications (spec N2). */
@ApiTags('me')
@ApiBearerAuth('app')
@Controller('me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Register this phone (after sign-in, on each app start, and whenever onRegistered gives an FID). */
  @Post()
  @ApiCreatedResponse({ type: RegisteredDeviceDto })
  register(
    @CurrentUser() user: User,
    @SessionId() sessionId: string | undefined,
    @Body() body: RegisterDeviceDto,
  ): Promise<RegisteredDeviceDto> {
    return this.devices.register(user.id, sessionId, body);
  }

  /** Remove a phone (on logout). 404 DEVICE_NOT_FOUND for someone else's or an unknown one. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: User,
    @Param('id', new ParseUUIDPipe({ exceptionFactory: deviceNotFound }))
    id: string,
  ): Promise<void> {
    return this.devices.remove(user.id, id);
  }
}
