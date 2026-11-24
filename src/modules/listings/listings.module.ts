import { FreshnessJob } from './freshness/freshness.job.js';
import { FreshnessService } from './freshness/freshness.service.js';
import { AvailabilityCheck } from './freshness/availability-check.entity.js';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { AdminModule } from '../admin/admin.module.js';
import { AreasModule } from '../areas/areas.module.js';
import { PhotosModule } from '../photos/photos.module.js';
import { ListingsAdminController } from './admin/listings-admin.controller.js';
import { ListingsAdminService } from './admin/listings-admin.service.js';
import { BrowseController } from './browse/browse.controller.js';
import { BrowseService } from './browse/browse.service.js';
import { ListingHistory } from './listing-history.entity.js';
import { Listing } from './listing.entity.js';
import { ListingsController } from './listings.controller.js';
import { ListingsService } from './listings.service.js';
import { DbPhotoCounter, PhotoCounter } from './photo-counter.js';
import { Property } from './property.entity.js';
import {
  PhotoUploadErrorFilter,
  PropertyPhotosController,
} from './property-photos.controller.js';
import { PropertyPhotosService } from './property-photos.service.js';
import { PublicPhotoReconciliationJob } from './public-photo-reconciliation.job.js';
import { PublicPhotoReconciliation } from './public-photo-reconciliation.service.js';
import { PublicPhotos } from './public-photos.js';

/** Properties, listings, their history and their photos (spec sections 3 and 4). */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Property,
      Listing,
      ListingHistory,
      AvailabilityCheck,
    ]),
    // The service-area check for the pin (G1).
    AreasModule,
    // Storage, re-encoding and the photo rows (P1, P2).
    PhotosModule,
    // The staff guards and the audit service for the review endpoints (section 8, S1).
    AdminModule,
    // Uploads stay in memory (one photo, at most PHOTO_MAX_BYTES), are re-encoded, then stored.
    // Multer has no size limit of its own, so every limit is set here: one file, no other fields.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        limits: {
          fileSize: config.get('PHOTO_MAX_BYTES', { infer: true }),
          files: 1,
          fields: 0,
        },
      }),
    }),
  ],
  controllers: [
    ListingsController,
    PropertyPhotosController,
    ListingsAdminController,
    BrowseController,
  ],
  providers: [
    ListingsService,
    ListingsAdminService,
    BrowseService,
    PropertyPhotosService,
    PublicPhotos,
    PublicPhotoReconciliation,
    PublicPhotoReconciliationJob,
    FreshnessService,
    FreshnessJob,
    PhotoUploadErrorFilter,
    { provide: PhotoCounter, useClass: DbPhotoCounter },
  ],
  exports: [TypeOrmModule],
})
export class ListingsModule {}
