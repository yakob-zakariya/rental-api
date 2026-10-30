import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

// Runs before the imports above are evaluated, so AppModule's config sees the low limit.
// Each e2e file gets its own module graph, so this doesn't leak into other files.
vi.hoisted(() => {
  process.env.OTP_REQUEST_IP_LIMIT_PER_HOUR = '2';
});

describe('per-IP limit on POST /auth/otp/request (A8, e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(new FakeSmsSender()),
    );
  });

  afterAll(async () => {
    await resetDatabase(app);
    await app.close();
  });

  const requestOtp = (phone: string) =>
    request(app.getHttpServer()).post('/auth/otp/request').send({ phone });

  it('allows OTP_REQUEST_IP_LIMIT_PER_HOUR requests per IP, across phones, then RATE_LIMITED', async () => {
    await requestOtp('+251911111111').expect(200);
    await requestOtp('+251922222222').expect(200);

    const response = await requestOtp('+251933333333').expect(429);
    expect(response.body).toEqual({ code: 'RATE_LIMITED' });
    expect(response.headers['retry-after-otp-request']).toBeDefined();
  });

  it('does not apply to other routes', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
