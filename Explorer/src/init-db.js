import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('[init-db] applying schema…');
  await pool.query(sql);
  console.log('[init-db] done');
  await pool.end();
}

main().catch(e => { console.error('[init-db] failed:', e); process.exit(1); });
