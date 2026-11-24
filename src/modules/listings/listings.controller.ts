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
   * Edits a listing: a missing field is kept, null clears it. On a live or stale listing, any
   * change except rent, available-from and negotiable sends it back to review (the answer's
   * `status` shows it). Errors: as POST, plus 400 NO_FIELDS_TO_UPDATE, LISTING_INCOMPLETE (a
   * required field emptied after submitting), 404 LISTING_NOT_FOUND, 409 INVALID_LISTING_STATE
   * (rented or removed).
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

  /**
   * Sends a draft or rejected listing to staff review (L2, L4).
   * Errors: 403 VERIFICATION_REQUIRED; 400 LISTING_INCOMPLETE (with `missing`), NOT_ENOUGH_PHOTOS
   * (with `min`); 404 LISTING_NOT_FOUND; 409 INVALID_LISTING_STATE, ACTIVE_LISTING_LIMIT (with
   * `max`).
   */
  @Post('listings/:id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyListingDto })
  submit(
    @CurrentUser() user: User,
    @Param('id', listingId) id: string,
  ): Promise<MyListingDto> {
    return this.listings.submit(user.id, id);
  }

  /**
   * Takes a listing out of review, back to draft.
   * Errors: 404 LISTING_NOT_FOUND, 409 INVALID_LISTING_STATE (not in review).
   */
  @Post('listings/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyListingDto })
  withdraw(
    @CurrentUser() user: User,
    @Param('id', listingId) id: string,
  ): Promise<MyListingDto> {
    return this.listings.withdraw(user.id, id);
  }

  /**
   * Reopens an expired listing (L6): back to live, or to review if it changed in a way that
   * needs review or was never approved. Errors: as submit.
   */
  @Post('listings/:id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: MyListingDto })
  reopen(
    @CurrentUser() user: User,
    @Param('id', listingId) id: string,
  ): Promise<MyListingDto> {
    return this.listings.reopen(user.id, id);
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
