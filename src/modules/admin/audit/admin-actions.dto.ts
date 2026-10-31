import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AdminActionType } from './audit.enums.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class ListAdminActionsQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ enum: AdminActionType })
  @IsOptional()
  @IsEnum(AdminActionType)
  action?: AdminActionType;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_SIZE, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'The nextCursor of the previous page.' })
  @IsOptional()
  @IsString()
  before?: string;
}

class AdminActionAdminDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;
}

export class AdminActionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: AdminActionType })
  action: string;

  @ApiProperty()
  targetType: string;

  @ApiProperty({ format: 'uuid' })
  targetId: string;

  @ApiProperty({ type: Object })
  details: Record<string, unknown>;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ type: AdminActionAdminDto })
  admin: AdminActionAdminDto;
}

export class AdminActionPageDto {
  @ApiProperty({ type: [AdminActionDto] })
  items: AdminActionDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `before` for the next page.',
  })
  nextCursor: string | null;
}
