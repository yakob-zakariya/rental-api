// Creates a staff account: `npm run admin:create -- --email you@example.com [--role super_admin]`.
// The password is asked for with hidden input (or read from ADMIN_PASSWORD for scripts); it is
// never accepted as a command-line argument, where it would end up in shell history.
import { parseArgs } from 'node:util';
import dataSource from '../database/data-source.js';
import { CreateAdminError, createAdmin } from '../modules/admin/admin-users.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      role: { type: 'string', default: 'super_admin' },
    },
    strict: true,
  });
  if (!values.email)
    throw new CreateAdminError(
      'Usage: npm run admin:create -- --email <email> [--role <role>]',
    );

  let password = process.env.ADMIN_PASSWORD;
  if (password === undefined) {
    password = await promptHidden('Password: ');
    if ((await promptHidden('Repeat password: ')) !== password) {
      throw new CreateAdminError('Passwords do not match');
    }
  }

  await dataSource.initialize();
  try {
    const admin = await dataSource.transaction((manager) =>
      createAdmin(manager, {
        email: values.email!,
        role: values.role!,
        password: password!,
      }),
    );
    console.log(`Created ${admin.role} ${admin.email}`);
  } finally {
    await dataSource.destroy();
  }
}

/** Reads one line without echoing it (falls back to a plain line when stdin isn't a terminal). */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let input = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => {
        input += chunk;
        const newline = input.indexOf('\n');
        if (newline >= 0) {
          stdin.pause();
          resolve(input.slice(0, newline).replace(/\r$/, ''));
        }
      });
    });
  }
  return new Promise((resolve, reject) => {
    let input = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(input);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new CreateAdminError('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') input = input.slice(0, -1);
        else input += char;
      }
    };
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    stdin.on('data', onData);
  });
}

main().catch((error: unknown) => {
  // A message, not a stack trace: e.g. an unknown option such as --password (never accepted).
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
