// Sends a test push to every signed-in phone of one user (T6.2): `npm run push:send-test -- <phone>`.
// Checks the whole chain on a real phone: the app registered its installation ID, the
// service-account key works, and Android shows the notification. Uses PUSH_PROVIDER as the API
// does (with console it only logs).
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module.js';
import { normaliseEthiopianMobile } from '../common/phone/ethiopian-phone.js';
import { PushService } from '../modules/push/push.service.js';

async function main(): Promise<void> {
  const input = process.argv[2];
  const phone = input ? normaliseEthiopianMobile(input) : null;
  if (!phone) {
    console.error('Usage: npm run push:send-test -- <phone, e.g. 0911234567>');
    process.exitCode = 1;
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const [user] = await app
      .get(DataSource)
      .query<{ id: string }[]>(`SELECT id FROM users WHERE phone = $1`, [
        phone,
      ]);
    if (!user) {
      console.error(`No user with the phone ${phone}.`);
      process.exitCode = 1;
      return;
    }
    const result = await app.get(PushService).sendTest(user.id);
    console.log(
      {
        sent: 'Sent. Check the phone.',
        no_device:
          'No signed-in phone registered for this user (or Firebase no longer knows it). Open the app, sign in, and try again.',
        failed: 'Sending failed; see the log above.',
      }[result],
    );
    if (result !== 'sent') process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
