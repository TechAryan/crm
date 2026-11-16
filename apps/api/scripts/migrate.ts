import { initDb, stopDb } from '../src/db.js';

initDb().then(async () => {
  console.log('migrations complete');
  await stopDb();
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
