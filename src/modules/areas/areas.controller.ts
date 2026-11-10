import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { AreasService } from './areas.service.js';
import { SubCityDto } from './dto/areas.dto.js';

@ApiTags('areas')
// Browsing works without an account (overview §3), and the picker needs this before sign-in.
@Public()
@Controller('areas')
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  /** Addis Ababa's sub-cities with their active neighbourhoods, in English and Amharic. */
  @Get()
  @ApiOkResponse({ type: [SubCityDto] })
  list(): Promise<SubCityDto[]> {
    return this.areas.listAreas();
  }
}
