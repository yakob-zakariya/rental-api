import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { ListingFieldsDto, MyListingDto } from './dto/listing.dto.js';
import { ListingsService, listingNotFound } from './listings.service.js';

// A malformed id can't name a listing: the same 404 as an unknown one.
const listingId = new ParseUUIDPipe({ exceptionFactory: listingNotFound });

/** The lister's listings (spec section 3). Signed-in, active users; no verification to draft (L1). */
@ApiTags('listings')
@ApiBearerAuth('app')
@Controller()
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  /** Your listings in every state, newest first. */
  @Get('me/listings')
  @ApiOkResponse({ type: [MyListingDto] })
  mine(@CurrentUser() user: User): Promise<MyListingDto[]> {
    return this.listings.listMine(user.id);
  }

  /**
   * A new draft: a property and its first listing. Every field is optional.
   * Errors: 400 VALIDATION_FAILED, a field over its limit (e.g. RENT_ABOVE_LIMIT, with `max`),
   * AVAILABLE_FROM_IN_PAST, LOCATION_OUTSIDE_SERVICE_AREA, NEIGHBOURHOOD_NOT_FOUND,
   * NEIGHBOURHOOD_INACTIVE; 409 DRAFT_LISTING_LIMIT (with `max`).
   */
  @Post('listings')
  @ApiCreatedResponse({ type: MyListingDto })
  create(
    @CurrentUser() user: User,
    @Body() body: ListingFieldsDto,
  ): Promise<MyListingDto> {
    return this.listings.create(user.id, body);
  }

  /**
   * Edits a draft: a missing field is kept, null clears it.
   * Errors: as POST, plus 400 NO_FIELDS_TO_UPDATE, 404 LISTING_NOT_FOUND, 409
   * INVALID_LISTING_STATE (not a draft).
   */
  @Patch('listings/:id')
  @ApiOkResponse({ type: MyListingDto })
  update(
    @CurrentUser() user: User,
    @Param('id', listingId) id: string,
    @Body() body: ListingFieldsDto,
  ): Promise<MyListingDto> {
    return this.listings.update(user.id, id, body);
  }

  /** Deletes a draft. Errors: 404 LISTING_NOT_FOUND, 409 INVALID_LISTING_STATE (not a draft). */
  @Delete('listings/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: User,
    @Param('id', listingId) id: string,
  ): Promise<void> {
    return this.listings.remove(user.id, id);
  }
}
