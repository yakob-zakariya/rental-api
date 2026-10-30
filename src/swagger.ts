import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { type EnvironmentVariables, NodeEnv } from './config/env.validation.js';

/** Always on outside production; in production only with SWAGGER_ENABLED=true. */
export function isSwaggerEnabled(
  env: Pick<EnvironmentVariables, 'NODE_ENV' | 'SWAGGER_ENABLED'>,
): boolean {
  return env.NODE_ENV !== NodeEnv.Production || env.SWAGGER_ENABLED;
}

/** Serves Swagger UI at /docs (and the spec at /docs-json). Phase 1's temporary admin UI. */
export function setupSwagger(
  app: INestApplication,
  env: Pick<EnvironmentVariables, 'NODE_ENV' | 'SWAGGER_ENABLED'>,
): void {
  if (!isSwaggerEnabled(env)) return;

  // TODO(T3.1): in production, protect the /docs page itself with staff auth (spec section 5).
  if (env.NODE_ENV === NodeEnv.Production) {
    new Logger('Swagger').warn('Swagger UI is enabled in production at /docs');
  }

  const config = new DocumentBuilder()
    .setTitle('rental-api')
    .setVersion('0.1')
    // App users and staff use separate tokens (hard rule 8), so they get separate schemes.
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'app',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'admin',
    )
    .build();

  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, config),
  );
}
