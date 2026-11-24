import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreasModule } from '../areas/areas.module.js';
import { ListingHistory } from './listing-history.entity.js';
import { Listing } from './listing.entity.js';
import { ListingsController } from './listings.controller.js';
import { ListingsService } from './listings.service.js';
import { NoPhotosYet, PhotoCounter } from './photo-counter.js';
import { Property } from './property.entity.js';

/** Properties, listings and their history (spec section 3). */
@Module({
  // AreasModule: the service-area check for the pin (G1).
  imports: [
    TypeOrmModule.forFeature([Property, Listing, ListingHistory]),
    AreasModule,
  ],
  controllers: [ListingsController],
  // PhotoCounter: no photos until T3.2, so nothing can be submitted outside tests.
  providers: [
    ListingsService,
    { provide: PhotoCounter, useClass: NoPhotosYet },
  ],
  exports: [TypeOrmModule],
})
export class ListingsModule {}
