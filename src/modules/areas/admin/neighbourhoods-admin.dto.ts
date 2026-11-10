import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { MAX_DETAIL_LENGTH } from '../../admin/audit/audit-details.js';

/** Column length of name_en / name_am. */
export const MAX_NAME_LENGTH = 100;

// Names are trimmed before the length check, so "  " is blank (and the DB check agrees).
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class NeighbourhoodListQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this sub-city' })
  @IsOptional()
  @IsUUID()
  subCityId?: string;

  @ApiPropertyOptional({
    description: 'Include deactivated neighbourhoods (default false)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CreateNeighbourhoodDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subCityId: string;

  @ApiProperty({ example: 'Gerji Mebrat Hail' })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  nameEn: string;

  @ApiProperty({ example: 'ገርጂ መብራት ኃይል' })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  nameAm: string;
}

export class UpdateNeighbourhoodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, MAX_NAME_LENGTH)
  nameAm?: string;
}

export class NeighbourhoodStatusChangeDto {
  @ApiPropertyOptional({
    description: 'Why (stored in the audit log). Never put ID numbers here.',
  })
  @IsOptional()
  @IsString()
  @Length(1, MAX_DETAIL_LENGTH)
  note?: string;
}

export class AdminNeighbourhoodDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) subCityId: string;
  @ApiProperty({ example: 'Bole' }) subCityNameEn: string;
  @ApiProperty() nameEn: string;
  @ApiProperty() nameAm: string;
  @ApiProperty({ description: 'False once deactivated (spec G8)' })
  active: boolean;
  @ApiProperty({ type: Date, nullable: true }) deactivatedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null for the seeded neighbourhoods',
  })
  createdByAdminId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
