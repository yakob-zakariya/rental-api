import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { PhotoStorage } from './photo-storage.js';
import { createS3Client } from './s3-client.js';
import { S3PhotoStorage } from './s3-photo-storage.js';

/** Listing photos (spec section 4). T3.1: storage only; upload, re-encoding and hashing follow. */
@Module({
  providers: [
    {
      provide: PhotoStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const get = <K extends keyof EnvironmentVariables>(key: K) =>
          config.get(key, { infer: true });
        return new S3PhotoStorage(
          createS3Client({
            S3_ENDPOINT: get('S3_ENDPOINT'),
            S3_REGION: get('S3_REGION'),
            S3_ACCESS_KEY_ID: get('S3_ACCESS_KEY_ID'),
            S3_SECRET_ACCESS_KEY: get('S3_SECRET_ACCESS_KEY'),
            S3_FORCE_PATH_STYLE: get('S3_FORCE_PATH_STYLE'),
          }),
          {
            S3_PRIVATE_BUCKET: get('S3_PRIVATE_BUCKET'),
            S3_PUBLIC_BUCKET: get('S3_PUBLIC_BUCKET'),
            S3_PUBLIC_BASE_URL: get('S3_PUBLIC_BASE_URL'),
            PHOTO_SIGNED_URL_TTL_SECONDS: get('PHOTO_SIGNED_URL_TTL_SECONDS'),
            PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS: get(
              'PHOTO_PUBLIC_CACHE_MAX_AGE_SECONDS',
            ),
          },
        );
      },
    },
  ],
  exports: [PhotoStorage],
})
export class PhotosModule {}
