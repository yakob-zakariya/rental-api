import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ProfileDto } from './dto/profile.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';

@ApiTags('me')
@ApiBearerAuth('app')
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  /** The signed-in user's profile, including their verification status. */
  @Get()
  @ApiOkResponse({ type: ProfileDto })
  getMe(@CurrentUser() user: User): ProfileDto {
    return this.users.toProfile(user);
  }

  /** Changes the preferred language — the only editable field in Phase 1. */
  @Patch()
  @ApiOkResponse({ type: ProfileDto })
  async updateMe(
    @CurrentUser() user: User,
    @Body() body: UpdateMeDto,
  ): Promise<ProfileDto> {
    return this.users.toProfile(
      await this.users.updatePreferredLanguage(user.id, body.preferredLanguage),
    );
  }
}
