import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type EnvironmentVariables,
  SmsProvider,
} from '../../config/env.validation.js';
import { ConsoleSmsSender } from './console-sms-sender.js';
import { SmsSender } from './sms-sender.js';

export function createSmsSender(provider: SmsProvider): SmsSender {
  switch (provider) {
    case SmsProvider.Console:
      return new ConsoleSmsSender();
    default: {
      // Adding a provider to the enum without handling it here is a type error.
      const unhandled: never = provider;
      throw new Error(`Unhandled SMS_PROVIDER: ${String(unhandled)}`);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SmsSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        createSmsSender(config.get('SMS_PROVIDER', { infer: true })),
    },
  ],
  exports: [SmsSender],
})
export class SmsModule {}
