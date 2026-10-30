import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { buildDataSourceOptions } from './data-source.options.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        ...buildDataSourceOptions({
          DATABASE_URL: config.get('DATABASE_URL', { infer: true }),
        }),
        // Entities come from each module's TypeOrmModule.forFeature, not a glob, so they load
        // through the normal module graph (including under Vitest). An entity the CLI sees but no
        // module registers will fail loudly at its first repository injection.
        autoLoadEntities: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
