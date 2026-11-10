import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { SubCityDto } from './dto/areas.dto.js';
import { Neighbourhood } from './neighbourhood.entity.js';
import { SubCity } from './sub-city.entity.js';

// Sorted here rather than by the database, so the order doesn't depend on the server's collation.
const byEnglishName = new Intl.Collator('en', { sensitivity: 'base' });
const compareNameEn = (a: { nameEn: string }, b: { nameEn: string }) =>
  byEnglishName.compare(a.nameEn, b.nameEn);

@Injectable()
export class AreasService {
  constructor(
    @InjectRepository(SubCity)
    private readonly subCities: Repository<SubCity>,
    @InjectRepository(Neighbourhood)
    private readonly neighbourhoods: Repository<Neighbourhood>,
  ) {}

  /**
   * Every sub-city with its active neighbourhoods (spec G7): what the app's picker and the
   * browse filters show. Deactivated neighbourhoods are left out (spec G8).
   */
  async listAreas(): Promise<SubCityDto[]> {
    const [subCities, neighbourhoods] = await Promise.all([
      this.subCities.find(),
      this.neighbourhoods.findBy({ deactivatedAt: IsNull() }),
    ]);

    const bySubCity = new Map<string, Neighbourhood[]>();
    for (const neighbourhood of neighbourhoods) {
      const list = bySubCity.get(neighbourhood.subCityId) ?? [];
      list.push(neighbourhood);
      bySubCity.set(neighbourhood.subCityId, list);
    }

    return subCities.sort(compareNameEn).map((subCity) => ({
      id: subCity.id,
      nameEn: subCity.nameEn,
      nameAm: subCity.nameAm,
      neighbourhoods: (bySubCity.get(subCity.id) ?? [])
        .sort(compareNameEn)
        .map(({ id, nameEn, nameAm }) => ({ id, nameEn, nameAm })),
    }));
  }
}
