import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('./.env', import.meta.url));
const requestedAddress = process.env.SITE_ADDRESS;
if (requestedAddress && !/^(:80|[a-zA-Z0-9.-]+)$/.test(requestedAddress)) throw new Error('SITE_ADDRESS must be a hostname, or :80 for HTTP.');
if (existsSync(envPath)) {
  if (requestedAddress) {
    const existing = readFileSync(envPath, 'utf8');
    writeFileSync(envPath, existing.replace(/^SITE_ADDRESS=.*$/m, `SITE_ADDRESS='${requestedAddress}'`), { mode: 0o600 });
  }
  console.log('Keeping existing docker/.env credentials and encryption key.');
} else {
  const username = 'admin';
  const password = randomBytes(24).toString('hex');
  const address = process.env.SITE_ADDRESS || ':80';
  const accounts = [{ username, password, fleetId: 'fleet_demo_001', role: 'platform_admin' }];
  const env = {
    NODE_ENV: 'production', DEMO_MODE: 'false', SITE_ADDRESS: address,
    JWT_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SIMULATOR_ADMIN_KEY: randomBytes(32).toString('hex'), ADMIN_USERNAME: username,
    SIMULATOR_PASSWORD: password, FLEET_ACCOUNTS: JSON.stringify(accounts),
  };
  writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(fileURLToPath(new URL('./credentials.txt', import.meta.url)),
    `Fleet login and simulator console\nUsername: ${username}\nPassword: ${password}\n`, { mode: 0o600 });
  console.log('Created production configuration. Your login is in docker/credentials.txt.');
}
