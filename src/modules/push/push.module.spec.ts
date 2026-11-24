import { PushProvider } from '../../config/env.validation.js';
import { ConsolePushSender } from './console-push-sender.js';
import { createPushSender } from './push.module.js';

describe('createPushSender (N1)', () => {
  it('console: the logging sender', () => {
    expect(createPushSender(PushProvider.Console, undefined)).toBeInstanceOf(
      ConsolePushSender,
    );
  });

  it("fcm with a file that can't be read: startup fails, naming the setting", () => {
    expect(() =>
      createPushSender(PushProvider.Fcm, '/nowhere/firebase.json'),
    ).toThrow("FCM_SERVICE_ACCOUNT_FILE: can't read /nowhere/firebase.json");
  });
});
