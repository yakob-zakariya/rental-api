import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module.js';
import { NeighbourhoodsAdminController } from './admin/neighbourhoods-admin.controller.js';
import { NeighbourhoodsAdminService } from './admin/neighbourhoods-admin.service.js';
import { AreasController } from './areas.controller.js';
import { AreasService } from './areas.service.js';
import { Neighbourhood } from './neighbourhood.entity.js';
import { SubCity } from './sub-city.entity.js';

@Module({
  // AdminModule: the staff guards and the audit service for the admin controller (spec G8).
  imports: [TypeOrmModule.forFeature([SubCity, Neighbourhood]), AdminModule],
  controllers: [AreasController, NeighbourhoodsAdminController],
  providers: [AreasService, NeighbourhoodsAdminService],
  exports: [TypeOrmModule, AreasService],
})
export class AreasModule {}
