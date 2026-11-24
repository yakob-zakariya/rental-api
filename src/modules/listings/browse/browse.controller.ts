import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator.js';
import { ViewerId } from '../../../common/decorators/viewer.decorator.js';
import { listingNotFound } from '../listing-state.js';
import { BrowsePageDto, BrowseQuery, ListingDetailDto } from './browse.dto.js';
import { BrowseService } from './browse.service.js';

const listingId = new ParseUUIDPipe({ exceptionFactory: listingNotFound });

/** Public browse and detail (spec G5, G6): no account needed; a signed-in viewer is recognised. */
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

  /**
   * One listing as tenants see it (G6). A listing that isn't public is 404 LISTING_NOT_FOUND,
   * except to its signed-in lister, who gets the same view as a preview.
   */
  @Get(':id')
  @ApiOkResponse({ type: ListingDetailDto })
  detail(
    @Param('id', listingId) id: string,
    @ViewerId() viewerId: string | undefined,
  ): Promise<ListingDetailDto> {
    return this.browse.detail(id, viewerId);
  }
}
