import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import type { EnvironmentVariables } from '../../config/env.validation.js';

/** The formats a lister may upload (P1), as sharp names its decoders' output. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/**
 * Only these image decoders may run, in the whole process (sharp's security guidance): a file
 * that claims to be a photo can't reach the SVG, PDF, TIFF, GIF or other parsers. Names checked
 * against sharp 0.35 / libvips 8.18 (T3.2); the e2e tests fail if one stops working.
 */
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: [
    'VipsForeignLoadJpegBuffer',
    'VipsForeignLoadPngBuffer',
    'VipsForeignLoadWebpBuffer',
  ],
});

/** JPEG quality of stored photos: good for phone screens, about a third of the original size. */
const JPEG_QUALITY = 82;

/**
 * Thumbnails for browse cards (T3.4, decided 2026-11-24): a page of 20 full photos would be
 * several MB on mobile data. Longest side in pixels, and a lower quality: they're shown small.
 */
export const THUMBNAIL_MAX_DIMENSION = 480;
const THUMBNAIL_JPEG_QUALITY = 75;

/** Seconds sharp may spend on one photo before giving up. */
const PROCESSING_TIMEOUT_SECONDS = 20;

export interface ProcessedPhoto {
  /** A new JPEG written from the pixels only: no byte of the upload is in it. */
  body: Buffer;
  width: number;
  height: number;
  /** The same picture, at most THUMBNAIL_MAX_DIMENSION px, written the same way (no metadata). */
  thumbnail: Buffer;
}

/**
 * Re-encodes an uploaded photo (spec P2). This is what keeps the exact location hidden: phone
 * photos carry GPS in EXIF, and also in XMP, in the EXIF thumbnail, in extra images (MPF depth
 * maps, HDR layers) and in data after the image (motion-photo videos). Deleting known tags would
 * miss some of these. Instead the photo is decoded to plain pixels and a brand-new JPEG is written
 * from the pixels alone, so nothing from the original file but the picture can survive.
 *
 * Steps:
 * 1. Read the header and check the real format from the content (never the file name or the
 *    type the phone claims) and the pixel count (decompression bombs).
 * 2. Decode strictly (`failOn: 'warning'`, sharp's advice for untrusted input); first frame only.
 * 3. Turn the picture upright from its EXIF orientation (`autoOrient`). This must happen while
 *    decoding: the orientation tag goes with the rest of the metadata, so a photo not turned now
 *    would stay sideways.
 * 4. Shrink to at most PHOTO_MAX_DIMENSION on the longest side (never enlarge).
 * 5. Convert to sRGB, so no colour profile is needed, and write a JPEG. sharp writes no metadata
 *    unless asked to (keepMetadata, keepExif, withMetadata…), and nothing here asks.
 * 6. Write a thumbnail the same way from the same decoded image (T3.4).
 */
@Injectable()
export class ImageProcessor {
  private readonly maxDimension: number;
  private readonly maxInputPixels: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.maxDimension = config.get('PHOTO_MAX_DIMENSION', { infer: true });
    this.maxInputPixels = config.get('PHOTO_MAX_INPUT_PIXELS', {
      infer: true,
    });
  }

  /**
   * Errors: 400 PHOTO_TYPE_NOT_ALLOWED (not JPEG, PNG or WebP), PHOTO_TOO_MANY_PIXELS (with
   * `max`), PHOTO_UNREADABLE (damaged, or sharp refuses it).
   */
  async reencode(input: Buffer): Promise<ProcessedPhoto> {
    const options = {
      failOn: 'warning',
      limitInputPixels: this.maxInputPixels,
      autoOrient: true,
    } as const;

    let header: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      // The header only, no pixels decoded, so no pixel limit here: our own check below can then
      // say why a bomb is refused. The limit stays on the decoding step as a second guard.
      header = await sharp(input, {
        ...options,
        limitInputPixels: false,
      }).metadata();
    } catch {
      // Includes every format whose decoder is blocked above: sharp can't even read its header.
      throw new BadRequestException({ code: 'PHOTO_TYPE_NOT_ALLOWED' });
    }
    if (!ACCEPTED_FORMATS.has(header.format ?? ''))
      throw new BadRequestException({ code: 'PHOTO_TYPE_NOT_ALLOWED' });
    if (header.width * header.height > this.maxInputPixels)
      throw new BadRequestException({
        code: 'PHOTO_TOO_MANY_PIXELS',
        max: this.maxInputPixels,
      });

    try {
      // One decode, two outputs: clone() reuses the decoded input for each pipeline.
      const decoded = sharp(input, options)
        .timeout({ seconds: PROCESSING_TIMEOUT_SECONDS })
        .toColourspace('srgb');
      const [{ data, info }, thumbnail] = await Promise.all([
        decoded
          .clone()
          .resize(this.maxDimension, this.maxDimension, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
          .toBuffer({ resolveWithObject: true }),
        decoded
          .clone()
          .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: THUMBNAIL_JPEG_QUALITY, mozjpeg: true })
          .toBuffer(),
      ]);
      return { body: data, width: info.width, height: info.height, thumbnail };
    } catch {
      throw new BadRequestException({ code: 'PHOTO_UNREADABLE' });
    }
  }
}
