import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreasController } from './areas.controller.js';
import { AreasService } from './areas.service.js';
import { Neighbourhood } from './neighbourhood.entity.js';
import { SubCity } from './sub-city.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([SubCity, Neighbourhood])],
  controllers: [AreasController],
  providers: [AreasService],
  exports: [TypeOrmModule, AreasService],
})
export class AreasModule {}
