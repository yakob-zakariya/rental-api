import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FakeSmsSender } from '../../../test/fakes/fake-sms-sender.js';
import { SmsProvider } from '../../config/env.validation.js';
import { ConsoleSmsSender } from './console-sms-sender.js';
import { SmsSender } from './sms-sender.js';
import { SmsModule } from './sms.module.js';

describe('ConsoleSmsSender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the recipient and text instead of sending', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await expect(
      new ConsoleSmsSender().send('+251911234567', 'Your code is 123456'),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('To +251911234567: Your code is 123456');
  });
});

describe('SmsModule', () => {
  it('provides ConsoleSmsSender when SMS_PROVIDER=console', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ SMS_PROVIDER: SmsProvider.Console })],
        }),
        SmsModule,
      ],
    }).compile();

    expect(moduleRef.get(SmsSender)).toBeInstanceOf(ConsoleSmsSender);
  });
});

describe('FakeSmsSender', () => {
  it('records messages and returns the latest one per recipient', async () => {
    const fake = new FakeSmsSender();

    await fake.send('+251911234567', 'first');
    await fake.send('+251711234567', 'other');
    await fake.send('+251911234567', 'second');

    expect(fake.sent).toHaveLength(3);
    expect(fake.lastTextTo('+251911234567')).toBe('second');
    expect(fake.lastTextTo('+251700000000')).toBeUndefined();

    fake.clear();
    expect(fake.sent).toHaveLength(0);
  });
});
