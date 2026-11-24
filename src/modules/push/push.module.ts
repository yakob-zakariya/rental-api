import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  type EnvironmentVariables,
  PushProvider,
} from '../../config/env.validation.js';
import { ConsolePushSender } from './console-push-sender.js';
import { Device } from './device.entity.js';
import { DevicesController, DevicesService } from './devices.js';
import { PushSender } from './push-sender.js';
import { PushService } from './push.service.js';

export function createPushSender(provider: PushProvider): PushSender {
  switch (provider) {
    case PushProvider.Console:
      return new ConsolePushSender();
    default: {
      // Adding a provider to the enum without handling it here is a type error.
      const unhandled: never = provider;
      throw new Error(`Unhandled PUSH_PROVIDER: ${String(unhandled)}`);
    }
  }
}

/** Push notifications (spec section 7): devices, the sender, the texts. Global, like SmsModule. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Device])],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    PushService,
    {
      provide: PushSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        createPushSender(config.get('PUSH_PROVIDER', { infer: true })),
    },
  ],
  exports: [PushService, PushSender],
})
export class PushModule {}
