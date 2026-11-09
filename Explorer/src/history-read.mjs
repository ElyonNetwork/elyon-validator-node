/** Static application SQL only. Parameters and writes remain with node-postgres. */
export function historyRead(text, tables) {
  if (!/^\s*(SELECT|WITH|UPDATE)\b/i.test(text)) return text;
  const names = tables.join('|');
  const reference = new RegExp(`\\b(FROM|JOIN)(\\s+)(?:public\\.)?(${names})\\b`, 'gi');
  // Preserve SQL string literals, quoted identifiers and comments verbatim.
  const rewritten = text.split(/('(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/)/g)
    .map((part, index) => index % 2 ? part : part.replace(reference, '$1$2history.$3')).join('');
  return addressRead(rewritten
    .replace(/SELECT\s+DISTINCT\s+tt\.token_addr\s+FROM\s+history\.token_transfers\s+tt\s+LEFT\s+JOIN\s+tokens\s+t\s+ON\s+t\.addr\s*=\s*tt\.token_addr\s+WHERE\s+t\.addr\s+IS\s+NULL\s+OR\s+t\.symbol\s+IS\s+NULL\s+OR\s+t\.symbol\s*=\s*''\s+LIMIT\s+500/gi,
      "SELECT token_addr FROM ((SELECT DISTINCT tt.token_addr FROM public.token_transfers tt LEFT JOIN tokens t ON t.addr=tt.token_addr WHERE t.addr IS NULL OR t.symbol IS NULL OR t.symbol='' LIMIT 500) UNION (SELECT tt.token_addr FROM archive_meta.token_stats tt LEFT JOIN tokens t ON t.addr=tt.token_addr WHERE t.addr IS NULL OR t.symbol IS NULL OR t.symbol='' LIMIT 500)) missing_tokens LIMIT 500")
    .replace(/SELECT\s+COUNT\(\*\)::bigint\s+AS\s+c\s+FROM\s+history\.token_transfers\s+WHERE\s+token_addr\s*=\s*\$1/gi,
      'SELECT ((SELECT count(*) FROM public.token_transfers WHERE token_addr=$1)+COALESCE((SELECT transfers FROM archive_meta.token_stats WHERE token_addr=$1),0))::bigint AS c')
    .replace(/FROM\s+history\.reserve_snapshots\s+rs\s+WHERE\s+rs\.chain_id\s*=\s*p\.chain_id\s+AND\s+rs\.pair\s*=\s*p\.address\s+ORDER\s+BY\s+block_number\s+DESC,\s*log_index\s+DESC\s+LIMIT\s+1/gi,
      'FROM (SELECT * FROM public.reserve_snapshots WHERE chain_id=p.chain_id AND pair=p.address UNION ALL SELECT * FROM history_cold.reserve_snapshots_all WHERE chain_id=p.chain_id AND pair=p.address AND block_number < COALESCE((SELECT block_until FROM archive_meta.progress WHERE id=1),0) AND NOT EXISTS(SELECT 1 FROM public.reserve_snapshots WHERE chain_id=p.chain_id AND pair=p.address)) rs ORDER BY block_number DESC,log_index DESC LIMIT 1')
    // Home-page figures: rows past the retention window are counted per hour when
    // archived. The oldest partial hour of the 24-hour window is left out.
    .replace(/SELECT\s+COUNT\(\*\)::bigint\s+AS\s+c\s+FROM\s+history\.txs\s+WHERE\s+timestamp\s*>\s*\$1/gi,
      'SELECT ((SELECT count(*) FROM public.txs WHERE timestamp > $1)+COALESCE((SELECT sum(txs) FROM archive_meta.tx_hourly WHERE hour >= $1),0))::bigint AS c')
    .replace(/SELECT\s+\(timestamp\s*\/\s*86400\)::bigint\s*\*\s*86400\s+AS\s+day,\s*COUNT\(\*\)::bigint\s+AS\s+c\s+FROM\s+history\.txs\s+WHERE\s+timestamp\s*>=\s*\$1\s+GROUP\s+BY\s+1\s+ORDER\s+BY\s+1\s+ASC/gi,
      'SELECT day,sum(c)::bigint AS c FROM (SELECT timestamp/86400*86400 AS day,count(*) AS c FROM public.txs WHERE timestamp >= $1 GROUP BY 1 UNION ALL SELECT hour/86400*86400,txs FROM archive_meta.tx_hourly WHERE hour >= $1) d GROUP BY day ORDER BY day ASC')
    .replace(/SELECT\s+MAX\(number\)\s+FROM\s+history\.blocks/gi,
      'SELECT GREATEST((SELECT max(number) FROM public.blocks),(SELECT block_until-1 FROM archive_meta.progress WHERE id=1))')
    .replace(/SELECT\s+gas_price\s+FROM\s+history\.txs\s+ORDER\s+BY\s+block_number\s+DESC\s+LIMIT\s+1000/gi,
      'SELECT gas_price FROM (SELECT gas_price,block_number FROM public.txs UNION ALL SELECT gas_price,block_number FROM history_cold.txs_all WHERE block_number < COALESCE((SELECT block_until FROM archive_meta.progress WHERE id=1),0) AND (SELECT count(*) FROM (SELECT 1 FROM public.txs LIMIT 1000) recent_count)<1000) recent_prices ORDER BY block_number DESC LIMIT 1000')
    .replace(new RegExp(`SELECT\\s+COUNT\\(\\*\\)(?:::bigint)?(\\s+AS\\s+\\w+)?\\s+FROM\\s+history\\.(${names})(?=\\s*(?:\\)|;|$))`, 'gi'),
    (_, alias, table) => `SELECT ((SELECT count(*) FROM public.${table}) + COALESCE((SELECT sum(rows) FROM archive_meta.chunks WHERE table_name='${table}'),0))::bigint${alias || ''}`)
    .replace(/SELECT\s+token_addr,\s*to_addr\s+AS\s+holder,\s*amount\s+AS\s+delta\s+FROM\s+history\.token_transfers\s+UNION\s+ALL\s+SELECT\s+token_addr,\s*from_addr\s+AS\s+holder,\s*-amount\s+AS\s+delta\s+FROM\s+history\.token_transfers/gi,
      'SELECT token_addr,holder,delta FROM history.token_positions')
    .replace(/SELECT\s+to_addr\s+AS\s+holder,\s*amount\s+AS\s+amt\s+FROM\s+history\.token_transfers\s+WHERE\s+token_addr\s*=\s*\$1\s+UNION\s+ALL\s+SELECT\s+from_addr\s+AS\s+holder,\s*-amount\s+AS\s+amt\s+FROM\s+history\.token_transfers\s+WHERE\s+token_addr\s*=\s*\$1/gi,
      'SELECT holder,delta AS amt FROM history.token_positions WHERE token_addr=$1')
    .replace(/SELECT\s+token_addr,\s*SUM\(CASE\s+WHEN\s+to_addr\s*=\s*\$1\s+THEN\s+amount\s+ELSE\s+0\s+END\s*-\s*CASE\s+WHEN\s+from_addr\s*=\s*\$1\s+THEN\s+amount\s+ELSE\s+0\s+END\)\s+AS\s+balance\s+FROM\s+history\.token_transfers\s+WHERE\s+from_addr\s*=\s*\$1\s+OR\s+to_addr\s*=\s*\$1\s+GROUP\s+BY\s+token_addr/gi,
      'SELECT token_addr,SUM(delta) AS balance FROM history.token_positions WHERE holder=$1 GROUP BY token_addr'));
}

/** Separate sender/recipient probes let indexes and Parquet equality filters work.
 * A self-transfer appears once; NULL senders remain visible on the receiver side.
 */
export function addressRead(text) {
  return text
    .replace(/FROM\s+((?:(?:public|history)\.)?(?:txs|token_transfers))\s+WHERE\s+from_addr\s*=\s*\$1\s+OR\s+to_addr\s*=\s*\$1\b/gi,
      (_, table) => `FROM (SELECT * FROM ${table} WHERE from_addr=$1 UNION ALL SELECT * FROM ${table} WHERE to_addr=$1 AND from_addr IS DISTINCT FROM $1) addressed`)
    .replace(/FROM\s+((?:(?:public|history)\.)?token_transfers)\s+tt\s+LEFT\s+JOIN\s+tokens\s+t\s+ON\s+t\.addr\s*=\s*tt\.token_addr\s+WHERE\s+tt\.from_addr\s*=\s*\$1\s+OR\s+tt\.to_addr\s*=\s*\$1\b/gi,
      (_, table) => `FROM (SELECT * FROM ${table} WHERE from_addr=$1 UNION ALL SELECT * FROM ${table} WHERE to_addr=$1 AND from_addr IS DISTINCT FROM $1) tt LEFT JOIN tokens t ON t.addr=tt.token_addr`);
}

export function uniqueRecentLookup(text) {
  return /^\s*SELECT\s+(?:\*|hash|number)\s+FROM\s+(?:public\.)?(?:txs|blocks)\s+WHERE\s+(?:hash|number)\s*=\s*\$1\s*;?\s*$/i.test(text);
}

/** A full page ordered by descending block is final if all rows are still hot. */
export function recentLimit(text, values) {
  if (!/^\s*SELECT\b/i.test(text) || /\b(GROUP|DISTINCT|UNION)\b|\(\s*SELECT\b/i.test(text)) return null;
  const m = text.match(/ORDER\s+BY\s+(?:\w+\.)?(?:block_number|number)\s+DESC\b[\s\S]*?LIMIT\s+\$(\d+)(?:\s+OFFSET\s+\$\d+)?\s*;?\s*$/i);
  if (!m) return null;
  const limit = Number(values[Number(m[1])-1]);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 ? limit : null;
}
