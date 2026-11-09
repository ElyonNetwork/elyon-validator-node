import { JsonRpcProvider, Interface, getAddress, hexlify } from 'ethers';
import { config } from './config.js';

export const provider = new JsonRpcProvider(config.rpcUrl, undefined, {
  staticNetwork: true,
  batchMaxCount: 10,
});

// Minimal ABI fragments we need to talk to ERC-20s and the registry.
export const ERC20_IFACE = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// 7-byte ASCII marker `URELAY1` placed in block.extraData before the
// 117-byte attestation records.
export const URELAY_MAGIC = Buffer.from('URELAY1', 'ascii');
export const ATTESTATION_SIZE = 117; // 32 + 20 + 65

// Pull URELAY1 attestation records out of a block's extraData hex string.
// Each record = txHash(32) + relayer(20) + secp256k1 sig(65). We deliberately
// do NOT verify signatures here — that's the chain's job; we just surface the
// (txHash → relayer) mapping the chain already trusted at block-build time.
export function parseUrelay(extraDataHex) {
  if (!extraDataHex || !extraDataHex.startsWith('0x')) return [];
  const buf = Buffer.from(extraDataHex.slice(2), 'hex');
  const i = buf.indexOf(URELAY_MAGIC);
  if (i < 0) return [];
  // Layout after the magic: u16 count, then count × (txHash 32 | relayer 20 | sig 65), then the seal.
  const countAt = i + URELAY_MAGIC.length;
  if (countAt + 2 > buf.length) return [];
  const count = buf.readUInt16BE(countAt);
  const body = buf.subarray(countAt + 2);
  const out = [];
  for (let n = 0, off = 0; n < count && off + ATTESTATION_SIZE <= body.length; n++, off += ATTESTATION_SIZE) {
    const txHash = body.subarray(off, off + 32).toString('hex');
    const relayer = body.subarray(off + 32, off + 52).toString('hex');
    const sig = body.subarray(off + 52, off + 117).toString('hex');
    out.push({ txHash, relayer, signature: sig });
  }
  return out;
}

// Cheap retry around RPC calls. The admin RPC occasionally returns 429s
// during heavy backfills.
export async function rpc(method, params = [], { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await provider.send(method, params); }
    catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

export function checksum(addr) {
  try { return getAddress('0x' + addr.replace(/^0x/, '')); } catch { return '0x' + addr; }
}

// ─── Revert-reason decoder ───────────────────────────────────────────
// Walks an error returned by eth_call (or any nested wrapper around it)
// looking for the actual return-data hex.
function findRevertData(err) {
  if (!err) return null;
  if (typeof err === 'string' && err.startsWith('0x')) return err;
  const candidates = [
    err.data, err.error?.data, err.info?.error?.data,
    err.cause?.data, err.cause?.error?.data, err.cause?.info?.error?.data,
    err.body, err.responseBody,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('0x') && c.length >= 2) return c;
    if (typeof c === 'string' && c.includes('0x')) {
      const m = c.match(/0x[0-9a-fA-F]+/);
      if (m && m[0].length > 2) return m[0];
    }
    if (c && typeof c === 'object') {
      const nested = findRevertData(c);
      if (nested) return nested;
    }
  }
  return null;
}

const PANIC_CODES = {
  '0x01': 'assertion failed',
  '0x11': 'arithmetic overflow/underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'storage byte array incorrectly encoded',
  '0x31': '.pop() called on empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'too much memory allocated',
  '0x51': 'invalid internal function call',
};

const ERROR_STRING_IFACE = new Interface(['error Error(string)']);

export function decodeRevert(data, { oog = false } = {}) {
  if (!data || data === '0x') {
    return oog
      ? { kind: 'oog',     message: 'Out of gas — the transaction consumed every wei of gas the sender provided.' }
      : { kind: 'unknown', message: 'execution reverted (no reason returned by the contract)' };
  }
  const hex = data.startsWith('0x') ? data.toLowerCase() : ('0x' + data.toLowerCase());
  const selector = hex.slice(0, 10);

  if (selector === '0x08c379a0') {
    try {
      const parsed = ERROR_STRING_IFACE.parseError(hex);
      const reason = parsed?.args?.[0];
      if (reason) return { kind: 'revert', selector, message: `execution reverted: ${reason}` };
    } catch { /* fall through */ }
  }
  if (selector === '0x4e487b71') {
    const code = '0x' + hex.slice(-2);
    const label = PANIC_CODES[code] || 'unknown panic';
    return { kind: 'panic', selector, message: `Panic(${code}) — ${label}` };
  }
  return {
    kind: 'custom-error',
    selector,
    data: hex,
    message: `Custom error · selector ${selector}` + (hex.length > 10 ? ' (payload trimmed)' : ''),
  };
}

// Replay a failed tx as eth_call against the parent block to surface the
// revert reason. Doesn't write anywhere — caller decides whether to cache.
export async function getRevertReason(txHashHex, blockNumber) {
  const tx = await rpc('eth_getTransactionByHash', [txHashHex]);
  if (!tx) return { kind: 'unknown', message: 'transaction not found on RPC' };
  const receipt = await rpc('eth_getTransactionReceipt', [txHashHex]);
  const gasUsed = receipt ? BigInt(receipt.gasUsed) : 0n;
  const gasGiven = tx.gas ? BigInt(tx.gas) : 0n;
  const oog = gasGiven > 0n && gasUsed === gasGiven;

  const params = {
    from:  tx.from,
    to:    tx.to || undefined,
    data:  tx.input || '0x',
    value: tx.value || '0x0',
  };
  if (tx.gas)      params.gas      = tx.gas;
  if (tx.gasPrice) params.gasPrice = tx.gasPrice;

  const parent = '0x' + (Number(blockNumber) - 1).toString(16);
  try {
    await rpc('eth_call', [params, parent]);
    // eth_call succeeded but the tx failed — usually because state changed
    // between the parent block and inclusion. Surface that explicitly.
    return { kind: 'unknown', message: 'failed at inclusion (replay against parent state did not revert)' };
  } catch (e) {
    const data = findRevertData(e);
    return decodeRevert(data, { oog });
  }
}
