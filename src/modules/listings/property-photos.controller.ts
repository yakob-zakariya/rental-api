import {
  type ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  HttpException,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { User } from '../users/user.entity.js';
import { MyListingDto, ReorderPhotosDto } from './dto/listing.dto.js';
import { propertyNotFound } from './listing-state.js';
import { PropertyPhotosService } from './property-photos.service.js';

const propertyId = new ParseUUIDPipe({ exceptionFactory: propertyNotFound });
const photoId = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException({ code: 'PHOTO_NOT_FOUND' }),
});

/**
 * Gives multer's own upload errors a stable code, like every other error: a file over
 * PHOTO_MAX_BYTES is 413 PHOTO_TOO_LARGE (with `max`), a malformed upload (another field name,
 * more than one file, extra fields) is 400 PHOTO_UPLOAD_INVALID. Errors that already have a code
 * pass through unchanged.
 */
@Catch(HttpException)
@Injectable()
export class PhotoUploadErrorFilter implements ExceptionFilter {
  private readonly maxBytes: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.maxBytes = config.get('PHOTO_MAX_BYTES', { infer: true });
  }

  catch(exception: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse();
    const status = exception.getStatus();
    if (typeof body === 'object' && 'code' in body)
      return response.status(status).json(body);
    if (exception instanceof PayloadTooLargeException)
      return response
        .status(status)
        .json({ code: 'PHOTO_TOO_LARGE', max: this.maxBytes });
    if (exception instanceof BadRequestException)
      return response.status(status).json({ code: 'PHOTO_UPLOAD_INVALID' });
    return response.status(status).json(body);
  }
}

/** A property's photos (spec P1, P2, P4), for its lister. */
@ApiTags('listings')
@ApiBearerAuth('app')
@Controller('properties/:id/photos')
export class PropertyPhotosController {
  constructor(private readonly photos: PropertyPhotosService) {}

  /**
   * Uploads one photo (multipart field `photo`), added at the end. JPEG, PNG or WebP; re-encoded
   * to a JPEG of at most 2048 px with all metadata, GPS included, removed (P2). On a live or stale
   * listing, the listing goes back to review (L5). Errors: 400 PHOTO_REQUIRED,
   * PHOTO_UPLOAD_INVALID, PHOTO_TYPE_NOT_ALLOWED, PHOTO_TOO_MANY_PIXELS, PHOTO_UNREADABLE; 404
   * PROPERTY_NOT_FOUND; 409 TOO_MANY_PHOTOS, INVALID_LISTING_STATE; 413 PHOTO_TOO_LARGE.
   */
  @Post()
  @UseInterceptors(FileInterceptor('photo'))
  @UseFilters(PhotoUploadErrorFilter)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['photo'],
      properties: { photo: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ type: MyListingDto })
  add(
    @CurrentUser() user: User,
    @Param('id', propertyId) id: string,
    // Multer's file object; only the in-memory bytes are used.
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ): Promise<MyListingDto> {
    if (!file) throw new BadRequestException({ code: 'PHOTO_REQUIRED' });
    return this.photos.add(user.id, id, file.buffer);
  }

  /**
   * Deletes a photo. Errors: 404 PROPERTY_NOT_FOUND, PHOTO_NOT_FOUND; 409 NOT_ENOUGH_PHOTOS (in
   * review or public, below 3), INVALID_LISTING_STATE.
   */
  @Delete(':photoId')
  @ApiOkResponse({ type: MyListingDto })
  remove(
    @CurrentUser() user: User,
    @Param('id', propertyId) id: string,
    @Param('photoId', photoId) photo: string,
  ): Promise<MyListingDto> {
    return this.photos.remove(user.id, id, photo);
  }

  /**
   * Sets the order (the first photo is the cover); applies at once, even on a live listing.
   * Errors: 400 PHOTO_ORDER_MISMATCH, 404 PROPERTY_NOT_FOUND, 409 INVALID_LISTING_STATE.
   */
  @Put('order')
  @ApiOkResponse({ type: MyListingDto })
  reorder(
    @CurrentUser() user: User,
    @Param('id', propertyId) id: string,
    @Body() body: ReorderPhotosDto,
  ): Promise<MyListingDto> {
    return this.photos.reorder(user.id, id, body.photoIds);
  }
}
