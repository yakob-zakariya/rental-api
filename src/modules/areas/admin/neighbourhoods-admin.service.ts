import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { AuditDetails } from '../../admin/audit/audit-details.js';
import {
  AdminActionType,
  AuditTargetType,
} from '../../admin/audit/audit.enums.js';
import { AuditService } from '../../admin/audit/audit.service.js';
import { Neighbourhood } from '../neighbourhood.entity.js';
import { SubCity } from '../sub-city.entity.js';
import type {
  AdminNeighbourhoodDto,
  CreateNeighbourhoodDto,
  NeighbourhoodListQuery,
  UpdateNeighbourhoodDto,
} from './neighbourhoods-admin.dto.js';

/** The database's "one English name per sub-city, ignoring case" index (spec section 2). */
const UNIQUE_NAME_INDEX = 'UQ_neighbourhoods_sub_city_id_lower_name_en';

export const neighbourhoodNotFound = () =>
  new NotFoundException({ code: 'NEIGHBOURHOOD_NOT_FOUND' });

const byEnglishName = new Intl.Collator('en', { sensitivity: 'base' });

interface LockedRow {
  id: string;
  name_en: string;
  name_am: string;
  active: boolean;
}

/**
 * Staff management of neighbourhoods (spec G8): add, rename, deactivate, reactivate. Nothing is
 * ever deleted. Every change writes its admin_actions row in the same transaction (S1).
 */
@Injectable()
export class NeighbourhoodsAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Sorted by sub-city, then name (English). Small enough not to need paging. */
  async list(query: NeighbourhoodListQuery): Promise<AdminNeighbourhoodDto[]> {
    const qb = this.dataSource
      .getRepository(Neighbourhood)
      .createQueryBuilder('n')
      .innerJoinAndSelect('n.subCity', 's');
    if (query.subCityId)
      qb.andWhere('n.subCityId = :subCityId', { subCityId: query.subCityId });
    if (!query.includeInactive) qb.andWhere('n.deactivatedAt IS NULL');

    const rows = await qb.getMany();
    return rows
      .sort(
        (a, b) =>
          byEnglishName.compare(a.subCity!.nameEn, b.subCity!.nameEn) ||
          byEnglishName.compare(a.nameEn, b.nameEn),
      )
      .map(toDto);
  }

  /** Errors: 404 SUB_CITY_NOT_FOUND, 409 NEIGHBOURHOOD_EXISTS. */
  async create(
    adminId: string,
    body: CreateNeighbourhoodDto,
  ): Promise<AdminNeighbourhoodDto> {
    const id = await this.transaction(async (manager) => {
      const subCity = await manager.findOneBy(SubCity, { id: body.subCityId });
      if (!subCity) throw new NotFoundException({ code: 'SUB_CITY_NOT_FOUND' });

      const [row] = await manager.query<{ id: string }[]>(
        `INSERT INTO neighbourhoods (sub_city_id, name_en, name_am, created_by_admin_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.subCityId, body.nameEn, body.nameAm, adminId],
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.NeighbourhoodCreate,
        targetType: AuditTargetType.Neighbourhood,
        targetId: row.id,
        details: { newNameEn: body.nameEn, newNameAm: body.nameAm },
      });
      return row.id;
    });
    return this.get(id);
  }

  /**
   * Renames one or both names. Properties keep the neighbourhood's id, so they show the new name.
   * A rename to the same names changes nothing and records nothing.
   * Errors: 400 NO_FIELDS_TO_UPDATE, 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_EXISTS.
   */
  async update(
    adminId: string,
    id: string,
    body: UpdateNeighbourhoodDto,
  ): Promise<AdminNeighbourhoodDto> {
    if (body.nameEn === undefined && body.nameAm === undefined)
      throw new BadRequestException({ code: 'NO_FIELDS_TO_UPDATE' });

    await this.transaction(async (manager) => {
      const current = await this.lock(manager, id);
      const details: AuditDetails = {};
      if (body.nameEn !== undefined && body.nameEn !== current.name_en) {
        details.oldNameEn = current.name_en;
        details.newNameEn = body.nameEn;
      }
      if (body.nameAm !== undefined && body.nameAm !== current.name_am) {
        details.oldNameAm = current.name_am;
        details.newNameAm = body.nameAm;
      }
      if (Object.keys(details).length === 0) return;

      await manager.query(
        `UPDATE neighbourhoods SET name_en = $2, name_am = $3, updated_at = now() WHERE id = $1`,
        [
          id,
          details.newNameEn ?? current.name_en,
          details.newNameAm ?? current.name_am,
        ],
      );
      await this.audit.record(manager, {
        adminId,
        action: AdminActionType.NeighbourhoodUpdate,
        targetType: AuditTargetType.Neighbourhood,
        targetId: id,
        details,
      });
    });
    return this.get(id);
  }

  /**
   * Hidden from the picker (GET /areas) and can't be newly chosen; properties that already have
   * it keep it. Errors: 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_ALREADY_INACTIVE.
   */
  deactivate(
    adminId: string,
    id: string,
    note?: string,
  ): Promise<AdminNeighbourhoodDto> {
    return this.setActive(adminId, id, false, note);
  }

  /** Errors: 404 NEIGHBOURHOOD_NOT_FOUND, 409 NEIGHBOURHOOD_ALREADY_ACTIVE. */
  reactivate(
    adminId: string,
    id: string,
    note?: string,
  ): Promise<AdminNeighbourhoodDto> {
    return this.setActive(adminId, id, true, note);
  }

  private async setActive(
    adminId: string,
    id: string,
    active: boolean,
    note: string | undefined,
  ): Promise<AdminNeighbourhoodDto> {
    await this.transaction(async (manager) => {
      const current = await this.lock(manager, id);
      if (current.active === active) {
        throw new ConflictException({
          code: active
            ? 'NEIGHBOURHOOD_ALREADY_ACTIVE'
            : 'NEIGHBOURHOOD_ALREADY_INACTIVE',
        });
      }
      await manager.query(
        `UPDATE neighbourhoods
         SET deactivated_at = ${active ? 'NULL' : 'now()'}, updated_at = now()
         WHERE id = $1`,
        [id],
      );
      await this.audit.record(manager, {
        adminId,
        action: active
          ? AdminActionType.NeighbourhoodReactivate
          : AdminActionType.NeighbourhoodDeactivate,
        targetType: AuditTargetType.Neighbourhood,
        targetId: id,
        details: { note },
      });
    });
    return this.get(id);
  }

  private async get(id: string): Promise<AdminNeighbourhoodDto> {
    const row = await this.dataSource.getRepository(Neighbourhood).findOne({
      where: { id },
      relations: { subCity: true },
    });
    if (!row) throw neighbourhoodNotFound();
    return toDto(row);
  }

  /** The row, locked until the transaction ends, so two staff actions can't both apply. */
  private async lock(manager: EntityManager, id: string): Promise<LockedRow> {
    const [row] = await manager.query<LockedRow[]>(
      `SELECT id, name_en, name_am, deactivated_at IS NULL AS active
       FROM neighbourhoods WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!row) throw neighbourhoodNotFound();
    return row;
  }

  /** A name clash is caught by the database's unique index, so it holds under a race too. */
  private async transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string }).constraint ===
          UNIQUE_NAME_INDEX
      ) {
        throw new ConflictException({ code: 'NEIGHBOURHOOD_EXISTS' });
      }
      throw error;
    }
  }
}

function toDto(row: Neighbourhood): AdminNeighbourhoodDto {
  return {
    id: row.id,
    subCityId: row.subCityId,
    subCityNameEn: row.subCity!.nameEn,
    nameEn: row.nameEn,
    nameAm: row.nameAm,
    active: row.deactivatedAt === null,
    deactivatedAt: row.deactivatedAt,
    createdByAdminId: row.createdByAdminId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
