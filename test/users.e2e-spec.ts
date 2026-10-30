import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { App } from 'supertest/types.js';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from '../src/modules/users/user.entity.js';
import {
  UserLanguage,
  UserStatus,
  VerificationStatus,
} from '../src/modules/users/user.enums.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

describe('users table (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<User>;

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(getRepositoryToken(User));
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const constraintOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(QueryFailedError);
    return (
      error as QueryFailedError & { driverError: { constraint?: string } }
    ).driverError.constraint;
  };

  it('gives a new user the spec defaults', async () => {
    const user = await users.save(users.create({ phone: '+251911234567' }));
    const loaded = await users.findOneByOrFail({ id: user.id });

    expect(loaded).toMatchObject({
      phone: '+251911234567',
      fullName: null,
      dateOfBirth: null,
      preferredLanguage: UserLanguage.Amharic,
      status: UserStatus.Active,
      verificationStatus: VerificationStatus.NotVerified,
      verifiedAt: null,
    });
    expect(loaded.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(loaded.createdAt).toBeInstanceOf(Date);
    expect(loaded.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate phone number', async () => {
    await users.save(users.create({ phone: '+251911234567' }));

    expect(await constraintOf(users.insert({ phone: '+251911234567' }))).toBe(
      'UQ_users_phone',
    );
  });

  it.each([
    '0911234567',
    '251911234567',
    '+0911234567',
    '+2519',
    '+251 911 234 567',
  ])('rejects the non-E.164 phone %s', async (phone) => {
    expect(await constraintOf(users.insert({ phone }))).toBe(
      'CHK_users_phone_e164',
    );
  });

  // The DB only enforces E.164. Which numbers may sign up is app policy (T1.2 / T1.4).
  it.each(['+251911234567', '+251711234567', '+447700900123'])(
    'accepts the E.164 phone %s',
    async (phone) => {
      await expect(users.insert({ phone })).resolves.toBeDefined();
    },
  );

  it('returns date_of_birth as a plain date with no time zone shift', async () => {
    const user = await users.save(
      users.create({ phone: '+251911234567', dateOfBirth: '1990-05-17' }),
    );

    const loaded = await users.findOneByOrFail({ id: user.id });
    expect(loaded.dateOfBirth).toBe('1990-05-17');
  });
});
