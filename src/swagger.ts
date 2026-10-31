import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { type EnvironmentVariables, NodeEnv } from './config/env.validation.js';
import { AdminAuthService } from './modules/admin/admin-auth.service.js';

/** Always on outside production; in production only with SWAGGER_ENABLED=true. */
export function isSwaggerEnabled(
  env: Pick<EnvironmentVariables, 'NODE_ENV' | 'SWAGGER_ENABLED'>,
): boolean {
  return env.NODE_ENV !== NodeEnv.Production || env.SWAGGER_ENABLED;
}

const DOCS_PATHS = ['/docs', '/docs-json', '/docs-yaml'];

/**
 * Serves Swagger UI at /docs (and the spec at /docs-json). Phase 1's temporary admin UI. In
 * production the pages themselves need staff credentials (HTTP Basic, checked against active
 * admin_users, spec §5); the admin API still needs the admin Bearer token.
 */
export function setupSwagger(
  app: INestApplication,
  env: Pick<EnvironmentVariables, 'NODE_ENV' | 'SWAGGER_ENABLED'>,
): void {
  if (!isSwaggerEnabled(env)) return;

  if (env.NODE_ENV === NodeEnv.Production) {
    const auth = app.get(AdminAuthService);
    app.use(
      DOCS_PATHS,
      docsBasicAuth(
        async (email, password) =>
          !!(await auth.checkCredentials(email, password)),
      ),
    );
    new Logger('Swagger').log(
      'Swagger UI at /docs, behind staff HTTP Basic auth',
    );
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

/**
 * HTTP Basic for the docs pages: `Authorization: Basic base64(email:password)`, verified by
 * `check` (which applies the staff login limits). Anything else gets 401 with a Basic challenge.
 */
export function docsBasicAuth(
  check: (email: string, password: string) => Promise<boolean>,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const credentials = parseBasicAuth(req.headers.authorization);
    try {
      if (
        credentials &&
        (await check(credentials.email, credentials.password))
      ) {
        next();
        return;
      }
    } catch (error) {
      next(error);
      return;
    }
    res.setHeader(
      'WWW-Authenticate',
      'Basic realm="rental-api docs", charset="UTF-8"',
    );
    res.status(401).json({ code: 'UNAUTHENTICATED' });
  };
}

export function parseBasicAuth(
  header: string | undefined,
): { email: string; password: string } | null {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { email: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}
