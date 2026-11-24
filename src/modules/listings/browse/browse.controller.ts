import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator.js';
import { BrowsePageDto, BrowseQuery } from './browse.dto.js';
import { BrowseService } from './browse.service.js';

/** Public browse (spec G5): no account needed. */
@ApiTags('browse')
@Public()
@Controller('listings')
export class BrowseController {
  constructor(private readonly browse: BrowseService) {}

  /**
   * Live listings, filtered and sorted, a page at a time. Near me (lat, lng, radiusKm) and the
   * distance come from each listing's approximate point, rounded to 100 m.
   */
  @Get()
  @ApiOkResponse({ type: BrowsePageDto })
  list(@Query() query: BrowseQuery): Promise<BrowsePageDto> {
    return this.browse.browse(query);
  }
}
