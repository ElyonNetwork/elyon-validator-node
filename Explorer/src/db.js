import pg from 'pg';
import { config } from './config.js';
import { historyRead, recentLimit, uniqueRecentLookup, addressRead } from './history-read.mjs';

// Numerics come back as JS Number → loses precision past 2^53. Tell pg to
// give us strings for all NUMERIC columns; we convert to BigInt in code.
pg.types.setTypeParser(1700, v => v); // NUMERIC
pg.types.setTypeParser(20,   v => v === null ? null : v); // BIGINT (stays string)

export const pool = new pg.Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  max: 20,
  idleTimeoutMillis: 30_000,
});
// A database restart terminates idle pooled clients; without a listener
// pg-pool re-emits that as an unhandled 'error' and the whole process exits.
pool.on('error', e => console.warn('[db] idle client error:', e?.message || e));

let historyAvailable;
// db: the pool, or a checked-out client for session settings.
export async function q(text, params = [], db = pool) {
  const rewritten = historyRead(text, ['blocks', 'txs', 'token_transfers', 'internal_txs', 'urelay_attestations']);
  if (rewritten !== text) {
    historyAvailable ??= pool.query("SELECT to_regclass('history.blocks') IS NOT NULL AS enabled").then(r => r.rows[0].enabled);
    if (await historyAvailable) {
      if (/^\s*SELECT\s+\*\s+FROM\s+token_transfers\s+WHERE\s+tx_hash\s*=\s*\$1\s+ORDER\s+BY\s+log_index\s+ASC\s*$/i.test(text)) {
        const recent = await db.query(text, params);
        if (recent.rows.length > 0) return recent.rows;
        // Check the parent after reading transfers: a cutover between queries
        // must lead to the archive fallback, never a false empty transfer list.
        const parent = await db.query('SELECT 1 FROM public.txs WHERE hash=$1', [params[0]]);
        if (parent.rows.length > 0) return recent.rows;
      }
      if (uniqueRecentLookup(text)) {
        const recent = await db.query(text, params);
        if (recent.rows.length > 0) return recent.rows;
      }
      const limit = recentLimit(text, params);
      if (limit !== null) {
        const recent = await db.query(addressRead(text), params);
        if (recent.rows.length === limit) return recent.rows;
      }
      text = rewritten;
    }
  }
  const res = await db.query(text, params);
  return res.rows;
}
export async function q1(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Convenience: strip 0x prefix, lower-case. Returns null for empty/0x0.
export function norm(addrOrHash) {
  if (!addrOrHash) return null;
  let s = String(addrOrHash).toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (!s || /^0+$/.test(s)) return null;
  return s;
}
