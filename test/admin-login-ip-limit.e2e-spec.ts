import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { DataSource } from 'typeorm';

// Runs before the imports are evaluated, so AppModule's config sees the low limit (production
// default: 10). Each e2e file gets its own module graph, so this doesn't leak into other files.
vi.hoisted(() => {
  process.env.ADMIN_LOGIN_IP_LIMIT_PER_15_MIN = '3';
});

describe('per-IP limit on POST /admin/auth/login (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await resetDatabase(app);
    await app.close();
  });

  it('allows ADMIN_LOGIN_IP_LIMIT_PER_15_MIN attempts per IP, across emails, then RATE_LIMITED', async () => {
    const admin = await createTestAdmin(app.get(DataSource));
    const login = (email: string, password: string) =>
      request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email, password });

    await login('a@example.test', 'wrong password!!').expect(401);
    await login('b@example.test', 'wrong password!!').expect(401);
    await login(admin.email, admin.password).expect(200);

    const response = await login(admin.email, admin.password).expect(429);
    expect(response.body).toEqual({ code: 'RATE_LIMITED' });
  });

  it('does not limit other admin routes', async () => {
    await request(app.getHttpServer()).get('/admin/auth/me').expect(401);
  });
});
