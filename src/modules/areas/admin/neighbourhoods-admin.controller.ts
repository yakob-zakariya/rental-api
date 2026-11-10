import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { AdminController } from '../../admin/admin-controller.decorator.js';
import { AdminRole } from '../../admin/admin.enums.js';
import { AdminUser } from '../../admin/admin-user.entity.js';
import { CurrentAdmin } from '../../admin/current-admin.decorator.js';
import { Roles } from '../../admin/roles.decorator.js';
import {
  AdminNeighbourhoodDto,
  CreateNeighbourhoodDto,
  NeighbourhoodListQuery,
  NeighbourhoodStatusChangeDto,
  UpdateNeighbourhoodDto,
} from './neighbourhoods-admin.dto.js';
import {
  NeighbourhoodsAdminService,
  neighbourhoodNotFound,
} from './neighbourhoods-admin.service.js';

// A malformed id can't name a neighbourhood: same 404 as an unknown one.
const neighbourhoodId = new ParseUUIDPipe({
  exceptionFactory: neighbourhoodNotFound,
});

/**
 * Staff manage neighbourhoods (spec G8). Reads: any staff role; changes: moderator+, each audited.
 * There is deliberately no DELETE: a neighbourhood is deactivated, never removed.
 */
@AdminController('neighbourhoods')
export class NeighbourhoodsAdminController {
  constructor(private readonly neighbourhoods: NeighbourhoodsAdminService) {}

  @Get()
  @ApiOkResponse({ type: [AdminNeighbourhoodDto] })
  list(
    @Query() query: NeighbourhoodListQuery,
  ): Promise<AdminNeighbourhoodDto[]> {
    return this.neighbourhoods.list(query);
  }

  /** Errors: 404 SUB_CITY_NOT_FOUND, 409 NEIGHBOURHOOD_EXISTS (also against a deactivated one). */
  @Post()
  @Roles(AdminRole.Moderator)
  @ApiCreatedResponse({ type: AdminNeighbourhoodDto })
  create(
    @CurrentAdmin() admin: AdminUser,
    @Body() body: CreateNeighbourhoodDto,
  ): Promise<AdminNeighbourhoodDto> {
    return this.neighbourhoods.create(admin.id, body);
  }

  /** Errors: 400 NO_FIELDS_TO_UPDATE, 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_EXISTS. */
  @Patch(':id')
  @Roles(AdminRole.Moderator)
  @ApiOkResponse({ type: AdminNeighbourhoodDto })
  update(
    @CurrentAdmin() admin: AdminUser,
    @Param('id', neighbourhoodId) id: string,
    @Body() body: UpdateNeighbourhoodDto,
  ): Promise<AdminNeighbourhoodDto> {
    return this.neighbourhoods.update(admin.id, id, body);
  }

  /** Errors: 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_ALREADY_INACTIVE. */
  @Post(':id/deactivate')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminNeighbourhoodDto })
  deactivate(
    @CurrentAdmin() admin: AdminUser,
    @Param('id', neighbourhoodId) id: string,
    @Body() body: NeighbourhoodStatusChangeDto,
  ): Promise<AdminNeighbourhoodDto> {
    return this.neighbourhoods.deactivate(admin.id, id, body.note);
  }

  /** Errors: 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_ALREADY_ACTIVE. */
  @Post(':id/reactivate')
  @Roles(AdminRole.Moderator)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminNeighbourhoodDto })
  reactivate(
    @CurrentAdmin() admin: AdminUser,
    @Param('id', neighbourhoodId) id: string,
    @Body() body: NeighbourhoodStatusChangeDto,
  ): Promise<AdminNeighbourhoodDto> {
    return this.neighbourhoods.reactivate(admin.id, id, body.note);
  }
}
