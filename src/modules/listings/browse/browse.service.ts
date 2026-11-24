import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { EnvironmentVariables } from '../../../config/env.validation.js';
import { cursorTimestampSql } from '../../admin/pagination.js';
import { PhotoStorage } from '../../photos/photo-storage.js';
import type { Amenity, PropertyType } from '../listings.enums.js';
import {
  type BrowseSort,
  decodeBrowseCursor,
  encodeBrowseCursor,
} from './browse-cursor.js';
import {
  type BrowseCardDto,
  type BrowsePageDto,
  type BrowseQuery,
  DEFAULT_BROWSE_PAGE,
  DEFAULT_RADIUS_KM,
} from './browse.dto.js';

interface Row {
  id: string;
  monthly_rent_birr: number;
  advance_months: number;
  negotiable: boolean;
  available_from: string;
  published_at: Date;
  published_cursor: string;
  type: PropertyType;
  bedrooms: number;
  bathrooms: number;
  furnished: boolean;
  size_m2: number | null;
  floor: number | null;
  amenities: Amenity[];
  sub_city_id: string;
  sub_city_name_en: string;
  sub_city_name_am: string;
  neighbourhood_id: string;
  neighbourhood_name_en: string;
  neighbourhood_name_am: string;
  approx_lat: number;
  approx_lng: number;
  distance_metres: number | null;
  photo_count: number;
  cover_key: string | null;
  cover_width: number | null;
  cover_height: number | null;
}

/** Per sort: the ORDER BY, and the cursor comparison (the value, then the id as tie-break). */
const ORDER: Record<
  BrowseSort,
  { by: string; after: string; value: string; cast: string }
> = {
  newest: {
    by: 'q.published_at DESC, q.id DESC',
    after: '<',
    value: 'q.published_at',
    cast: 'timestamptz',
  },
  rent_asc: {
    by: 'q.monthly_rent_birr ASC, q.id ASC',
    after: '>',
    value: 'q.monthly_rent_birr',
    cast: 'int',
  },
  rent_desc: {
    by: 'q.monthly_rent_birr DESC, q.id DESC',
    after: '<',
    value: 'q.monthly_rent_birr',
    cast: 'int',
  },
  distance: {
    by: 'q.distance_metres ASC, q.id ASC',
    after: '>',
    value: 'q.distance_metres',
    cast: 'int',
  },
};

/**
 * Public browse (spec G4, G5; T5.1): only live listings of active listers. Every location
 * question (the radius, the distance, the distance sort) is answered from the approximate point,
 * never the exact one, and distances are rounded to 100 m. Cards carry the cover's thumbnail
 * (T3.4) and never the exact point, the landmark, the typed neighbourhood name or the lister.
 */
@Injectable()
export class BrowseService {
  private readonly maxRadiusKm: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxRadiusKm = config.get('SEARCH_MAX_RADIUS_KM', { infer: true });
  }

  /**
   * Errors: 400 VALIDATION_FAILED, RENT_RANGE_INVALID, LOCATION_INCOMPLETE (lat without lng, or a
   * radius without a point), RADIUS_TOO_LARGE (with `max`), DISTANCE_SORT_NEEDS_LOCATION,
   * INVALID_CURSOR.
   */
  async browse(query: BrowseQuery): Promise<BrowsePageDto> {
    const sort = query.sort ?? 'newest';
    const near = this.nearMe(query);
    if (sort === 'distance' && !near)
      throw new BadRequestException({ code: 'DISTANCE_SORT_NEEDS_LOCATION' });
    if (
      query.minRent !== undefined &&
      query.maxRent !== undefined &&
      query.minRent > query.maxRent
    )
      throw new BadRequestException({ code: 'RENT_RANGE_INVALID' });

    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    // The approximate point only (G4); rounded to 100 m.
    let distance = 'NULL::int';
    const where = [`l.status = 'live'`, `u.status = 'active'`];
    if (near) {
      const point = `ST_SetSRID(ST_MakePoint(${param(near.lng)}, ${param(near.lat)}), 4326)::geography`;
      distance = `(round(ST_Distance(p.approx_location, ${point}) / 100) * 100)::int`;
      where.push(
        `ST_DWithin(p.approx_location, ${point}, ${param(near.radiusKm * 1000)})`,
      );
    }
    if (query.subCityId)
      where.push(`n.sub_city_id = ${param(query.subCityId)}`);
    if (query.neighbourhoodId)
      where.push(`p.neighbourhood_id = ${param(query.neighbourhoodId)}`);
    if (query.minRent !== undefined)
      where.push(`l.monthly_rent_birr >= ${param(query.minRent)}`);
    if (query.maxRent !== undefined)
      where.push(`l.monthly_rent_birr <= ${param(query.maxRent)}`);
    if (query.maxAdvanceMonths !== undefined)
      where.push(`l.advance_months <= ${param(query.maxAdvanceMonths)}`);
    if (query.type) where.push(`p.type = ${param(query.type)}`);
    if (query.minBedrooms !== undefined)
      where.push(`p.bedrooms >= ${param(query.minBedrooms)}`);
    if (query.furnished !== undefined)
      where.push(`p.furnished = ${param(query.furnished)}`);

    const order = ORDER[sort];
    const after: string[] = [];
    if (query.after) {
      const cursor = decodeBrowseCursor(query.after, sort);
      after.push(
        `(${order.value}, q.id) ${order.after} (${param(cursor.value)}::${order.cast}, ${param(cursor.id)}::uuid)`,
      );
    }
    const limit = query.limit ?? DEFAULT_BROWSE_PAGE;

    const rows = await this.dataSource.query<Row[]>(
      `SELECT * FROM (
         SELECT l.id, l.monthly_rent_birr, l.advance_months, l.negotiable,
           l.available_from::text, l.published_at,
           ${cursorTimestampSql('l.published_at')} AS published_cursor,
           p.type, p.bedrooms, p.bathrooms, p.furnished, p.size_m2, p.floor,
           p.amenities::text[] AS amenities,
           s.id AS sub_city_id, s.name_en AS sub_city_name_en, s.name_am AS sub_city_name_am,
           n.id AS neighbourhood_id, n.name_en AS neighbourhood_name_en,
           n.name_am AS neighbourhood_name_am,
           ST_Y(p.approx_location::geometry) AS approx_lat,
           ST_X(p.approx_location::geometry) AS approx_lng,
           ${distance} AS distance_metres,
           (SELECT count(*)::int FROM property_photos ph WHERE ph.property_id = p.id) AS photo_count,
           cover.thumbnail_key AS cover_key, cover.width AS cover_width, cover.height AS cover_height
         FROM listings l
         JOIN properties p ON p.id = l.property_id
         JOIN users u ON u.id = p.lister_id
         JOIN neighbourhoods n ON n.id = p.neighbourhood_id
         JOIN sub_cities s ON s.id = n.sub_city_id
         LEFT JOIN LATERAL (
           SELECT ph.thumbnail_key, ph.width, ph.height FROM property_photos ph
           WHERE ph.property_id = p.id ORDER BY ph.position LIMIT 1
         ) cover ON true
         WHERE ${where.join(' AND ')}
       ) q
       ${after.length > 0 ? `WHERE ${after.join(' AND ')}` : ''}
       ORDER BY ${order.by}
       LIMIT ${param(limit + 1)}`,
      params,
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.card(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeBrowseCursor({
              sort,
              id: last.id,
              value:
                sort === 'newest'
                  ? last.published_cursor
                  : sort === 'distance'
                    ? last.distance_metres!
                    : last.monthly_rent_birr,
            })
          : null,
    };
  }

  /** The point and radius of a "near me" search, if there is one. */
  private nearMe(query: BrowseQuery) {
    const hasLat = query.lat !== undefined;
    const hasLng = query.lng !== undefined;
    if (hasLat !== hasLng || (query.radiusKm !== undefined && !hasLat))
      throw new BadRequestException({ code: 'LOCATION_INCOMPLETE' });
    if (!hasLat) return null;
    const radiusKm = query.radiusKm ?? DEFAULT_RADIUS_KM;
    if (radiusKm > this.maxRadiusKm)
      throw new BadRequestException({
        code: 'RADIUS_TOO_LARGE',
        max: this.maxRadiusKm,
      });
    return { lat: query.lat!, lng: query.lng!, radiusKm };
  }

  private card(row: Row): BrowseCardDto {
    return {
      id: row.id,
      monthlyRentBirr: row.monthly_rent_birr,
      advanceMonths: row.advance_months,
      negotiable: row.negotiable,
      availableFrom: row.available_from,
      publishedAt: row.published_at,
      type: row.type,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      furnished: row.furnished,
      sizeM2: row.size_m2,
      floor: row.floor,
      amenities: row.amenities,
      subCity: {
        id: row.sub_city_id,
        nameEn: row.sub_city_name_en,
        nameAm: row.sub_city_name_am,
      },
      neighbourhood: {
        id: row.neighbourhood_id,
        nameEn: row.neighbourhood_name_en,
        nameAm: row.neighbourhood_name_am,
      },
      approxLocation: { lat: row.approx_lat, lng: row.approx_lng },
      distanceMetres: row.distance_metres,
      photoCount: row.photo_count,
      // Live: the photos are in the public bucket (R7), so a plain URL, not a signed link.
      cover: row.cover_key
        ? {
            thumbnailUrl: this.storage.publicUrl(row.cover_key),
            width: row.cover_width!,
            height: row.cover_height!,
          }
        : null,
    };
  }
}
