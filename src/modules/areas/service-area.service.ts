import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ADDIS_ABABA_TIME_ZONE } from '../../common/dates.js';

/**
 * Is a point inside the city a listing may be placed in (spec G1)? Strict: no margin outside the
 * boundary (decided 2026-11-10); a point exactly on the boundary counts as inside.
 */
@Injectable()
export class ServiceAreaService {
  private readonly logger = new Logger(ServiceAreaService.name);

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

  /**
   * For a lister's pin: throws 400 LOCATION_OUTSIDE_SERVICE_AREA if it's outside, after recording
   * the refusal (G1). The app shows "We're only in Addis Ababa for now".
   */
  async requireInside(latitude: number, longitude: number): Promise<void> {
    if (await this.isInside(latitude, longitude)) return;
    await this.recordRefusal(latitude, longitude);
    throw new BadRequestException({ code: 'LOCATION_OUTSIDE_SERVICE_AREA' });
  }

  /**
   * Adds 1 to the pin's ~1 km cell for today (Addis Ababa date). Runs on its own, outside any
   * caller's transaction, so the error that follows doesn't undo it; ON CONFLICT makes two
   * refusals at once both count. Best effort: a failure is logged (without the point) and the
   * lister still gets the 400.
   */
  private async recordRefusal(
    latitude: number,
    longitude: number,
  ): Promise<void> {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return;
    try {
      await this.dataSource.query(
        `INSERT INTO out_of_area_demand (lat_rounded, lng_rounded, day)
         VALUES (round($1::numeric, 2), round($2::numeric, 2), (now() AT TIME ZONE $3)::date)
         ON CONFLICT (lat_rounded, lng_rounded, day)
         DO UPDATE SET refusals = out_of_area_demand.refusals + 1`,
        [latitude, longitude, ADDIS_ABABA_TIME_ZONE],
      );
    } catch (error) {
      this.logger.warn(
        `Could not record an out-of-area pin: ${(error as Error).message}`,
      );
    }
  }
}
