import { Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AdminController } from '../admin-controller.decorator.js';
import {
  AdminActionPageDto,
  ListAdminActionsQuery,
} from './admin-actions.dto.js';
import { AdminActionsService } from './admin-actions.service.js';

@AdminController('actions')
export class AdminActionsController {
  constructor(private readonly actions: AdminActionsService) {}

  /**
   * The audit log, newest first (any staff role: a read, S2). Filter by targetId, adminId or
   * action; page with `limit` (default 50, max 200) and `before` (the previous nextCursor).
   */
  @Get()
  @ApiOkResponse({ type: AdminActionPageDto })
  list(@Query() query: ListAdminActionsQuery): Promise<AdminActionPageDto> {
    return this.actions.list(query);
  }
}
