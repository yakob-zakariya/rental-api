import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingHistory } from './listing-history.entity.js';
import { Listing } from './listing.entity.js';
import { Property } from './property.entity.js';

/** Properties, listings and their history (spec section 3). Endpoints come in T2.2 onward. */
@Module({
  imports: [TypeOrmModule.forFeature([Property, Listing, ListingHistory])],
  exports: [TypeOrmModule],
})
export class ListingsModule {}
