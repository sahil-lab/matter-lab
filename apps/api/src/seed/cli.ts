import { loadConfig } from '../config.js';
import { Database } from '../db.js';
import { seedAll } from './run.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database({ connectionString: config.databaseUrl, maxSize: 2 });
  await db.ping();
  try {
    const report = await seedAll(db);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('seed failed', error);
  process.exitCode = 1;
});
