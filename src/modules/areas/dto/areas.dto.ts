import { ApiProperty } from '@nestjs/swagger';

export class NeighbourhoodDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Arat Kilo' })
  nameEn: string;

  @ApiProperty({ example: 'አራት ኪሎ' })
  nameAm: string;
}

export class SubCityDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Arada' })
  nameEn: string;

  @ApiProperty({ example: 'አራዳ' })
  nameAm: string;

  @ApiProperty({
    type: [NeighbourhoodDto],
    description: 'Active neighbourhoods only, sorted by English name.',
  })
  neighbourhoods: NeighbourhoodDto[];
}
