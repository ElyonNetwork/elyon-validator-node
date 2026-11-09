// Wallet discovery + connect for the Elyon Explorer.
//
// We do EIP-6963 (announce / request) first — the modern standard that
// handles multiple injected wallets cleanly. We fall back to the legacy
// `window.ethereum` if no announces come in. The first time the user
// clicks Connect, if neither is ready, we wait briefly (some wallets
// inject after our module loads) before declaring the wallet missing.

import { short } from './common.js';

const announced = new Map();         // rdns → { info, provider }
let cachedAccount = null;

// Listen for any wallet that announces itself.
window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = event.detail;
  if (!detail?.provider || !detail?.info) return;
  announced.set(detail.info.rdns || detail.info.uuid, detail);
});
// Ask wallets to announce themselves. The event listener above will fire
// synchronously for any wallet that's already loaded.
window.dispatchEvent(new Event('eip6963:requestProvider'));

function pickProvider() {
  // Prefer EIP-6963 announcements (they handle multi-wallet sanely).
  if (announced.size > 0) {
    // Stable order: MetaMask first if present, then anything else.
    const entries = [...announced.values()];
    entries.sort((a, b) =>
      (b.info.rdns === 'io.metamask') - (a.info.rdns === 'io.metamask'));
    return entries[0].provider;
  }
  // Legacy fallback. Some wallets *only* set window.ethereum.
  if (window.ethereum) return window.ethereum;
  return null;
}

// Wait up to `timeoutMs` for a provider to become available. Useful on
// first click — a wallet that injects in `document_idle` may not be ready
// the instant our module evaluates.
async function waitForProvider(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Re-announce in case the page loaded with an old request event.
    if (announced.size === 0 && !window.ethereum) {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    }
    const p = pickProvider();
    if (p) return p;
    await new Promise(r => setTimeout(r, 80));
  }
  return null;
}

export async function getAccount() {
  const p = pickProvider();
  if (!p) return null;
  try {
    const accs = await p.request({ method: 'eth_accounts' });
    return accs?.[0] || null;
  } catch { return null; }
}

export async function connect() {
  const p = await waitForProvider(1500);
  if (!p) {
    alert('No injected wallet found.\n\nInstall MetaMask, Rabby, Trust Wallet, or any EIP-1193 / EIP-6963 wallet, then reload this page.\n\nIf you already have one installed, try disabling any conflicting wallet extensions (multiple can collide) and reload.');
    return null;
  }
  try {
    const accs = await p.request({ method: 'eth_requestAccounts' });
    cachedAccount = accs?.[0] || null;
    return cachedAccount;
  } catch (e) {
    if (e.code !== 4001) alert('Connect failed: ' + (e.message || e));
    return null;
  }
}

export async function addNetwork(chainInfo) {
  const p = await waitForProvider(1500);
  if (!p) { alert('Install a wallet first to add the network.'); return false; }
  if (!chainInfo?.chainId) { alert('Chain ID unavailable; cannot add network.'); return false; }
  try {
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainInfo.chainIdHex || ('0x' + chainInfo.chainId.toString(16)),
        chainName: chainInfo.chainName || 'Elyon Chain',
        nativeCurrency: {
          name:    chainInfo.nativeToken?.name || 'Elyon',
          symbol:  chainInfo.nativeToken?.symbol || 'ELN',
          decimals: chainInfo.nativeToken?.decimals || 18,
        },
        rpcUrls: [chainInfo.rpcUrl],
        blockExplorerUrls: [location.origin],
      }],
    });
    return true;
  } catch (e) {
    if (e.code !== 4001) alert('Add network failed: ' + (e.message || e));
    return false;
  }
}

export function initWallet(btn, label) {
  if (!btn) return;
  paint();
  btn.addEventListener('click', async () => {
    const cur = await getAccount();
    if (cur) {
      const ch = await fetch('/api/chain').then(r => r.json()).catch(() => null);
      const ok = confirm(`Connected as ${cur}\n\nClick OK to (re)add ${ch?.chainName || 'Elyon Chain'} to your wallet.`);
      if (ok && ch) addNetwork(ch);
      return;
    }
    const a = await connect();
    if (a) {
      const ch = await fetch('/api/chain').then(r => r.json()).catch(() => null);
      if (ch) addNetwork(ch);
      paint();
    }
  });
  // Subscribe to provider events on whichever provider is currently picked.
  const sub = () => {
    const p = pickProvider();
    if (!p?.on) return;
    p.on('accountsChanged', paint);
    p.on('chainChanged', paint);
  };
  sub();
  // Re-subscribe if a wallet announces itself after page load.
  window.addEventListener('eip6963:announceProvider', () => { sub(); paint(); });

  async function paint() {
    const a = await getAccount();
    if (a) {
      btn.classList.add('connected');
      label.textContent = short(a);
    } else {
      btn.classList.remove('connected');
      label.textContent = 'Connect Wallet';
    }
  }
}
