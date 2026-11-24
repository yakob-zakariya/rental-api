import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { assertStorageKey, PhotoStorage } from './photo-storage.js';

export type PhotoStorageSettings = Pick<
  EnvironmentVariables,
  | 'S3_PRIVATE_BUCKET'
  | 'S3_PUBLIC_BUCKET'
  | 'S3_PUBLIC_BASE_URL'
  | 'PHOTO_SIGNED_URL_TTL_SECONDS'
  | 'PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS'
>;

/** PhotoStorage on any S3-compatible store: SeaweedFS in development, R2 or similar in production. */
export class S3PhotoStorage extends PhotoStorage {
  private readonly publicBase: string;

  constructor(
    private readonly s3: S3Client,
    private readonly settings: PhotoStorageSettings,
  ) {
    super();
    this.publicBase = settings.S3_PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  async putPrivate(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertStorageKey(key);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.settings.S3_PRIVATE_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Never kept by a shared cache: only the signed link's holder may see it.
        CacheControl: 'private',
      }),
    );
  }

  async deletePrivate(key: string): Promise<void> {
    assertStorageKey(key);
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.settings.S3_PRIVATE_BUCKET,
        Key: key,
      }),
    );
  }

  signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    assertStorageKey(key);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.settings.S3_PRIVATE_BUCKET,
        Key: key,
      }),
      { expiresIn: ttlSeconds ?? this.settings.PHOTO_SIGNED_URL_TTL_SECONDS },
    );
  }

  async publish(key: string): Promise<void> {
    assertStorageKey(key);
    // REPLACE lets the copy carry its own Cache-Control, but then the content type must be given
    // again: it's read from the private copy.
    const source = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.settings.S3_PRIVATE_BUCKET,
        Key: key,
      }),
    );
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.settings.S3_PUBLIC_BUCKET,
        Key: key,
        // Keys match STORAGE_KEY, so they need no URL encoding.
        CopySource: `${this.settings.S3_PRIVATE_BUCKET}/${key}`,
        MetadataDirective: 'REPLACE',
        ContentType: source.ContentType,
        // Moderate, not "immutable for a year" (decided 2026-11-24): an unpublished photo stays in
        // phone and CDN caches for this long.
        CacheControl: `public, max-age=${this.settings.PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS}`,
      }),
    );
  }

  async unpublish(key: string): Promise<void> {
    assertStorageKey(key);
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.settings.S3_PUBLIC_BUCKET,
        Key: key,
      }),
    );
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return `${this.publicBase}/${key}`;
  }
}
