import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { FakeSmsSender } from '../fakes/fake-sms-sender.js';

/** Signs in over HTTP (OTP request + verify) and returns the token pair. */
export async function signIn(
  app: INestApplication<App>,
  sms: FakeSmsSender,
  phone: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  await request(app.getHttpServer())
    .post('/auth/otp/request')
    .send({ phone })
    .expect(200);
  const code = /code is (\d{6})/.exec(sms.lastTextTo(phone) ?? '')?.[1];
  if (!code) throw new Error(`No OTP SMS was sent to ${phone}`);
  const response = await request(app.getHttpServer())
    .post('/auth/otp/verify')
    .send({ phone, code })
    .expect(200);
  return response.body;
}
