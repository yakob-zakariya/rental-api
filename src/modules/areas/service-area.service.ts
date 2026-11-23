import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Is a point inside the city a listing may be placed in (spec G1)? Strict: no margin outside the
 * boundary (decided 2026-11-10); a point exactly on the boundary counts as inside.
 */
@Injectable()
export class ServiceAreaService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Latitude first, as people say it ("9.01, 38.76"). PostGIS points are (longitude, latitude),
   * which is swapped below in one place only. Non-finite or out-of-range values are never inside.
   */
  async isInside(latitude: number, longitude: number): Promise<boolean> {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return false;
    }
    const [row] = await this.dataSource.query<{ inside: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM service_area
         WHERE ST_Covers(boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
       ) AS inside`,
      [longitude, latitude],
    );
    return row.inside;
  }
}
