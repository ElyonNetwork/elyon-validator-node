// Featured tokens shown on the home page and rendered with the "pro" token
// page (TradingView price + chart + news + holders). All were minted to the
// same issuer wallet, which is excluded from the holders list.
export const TOKEN_ISSUER = '0xe26f1a776778912c3747f6fd240b573cd57b5601';

export const MAINNET_CHAIN_ID = '55452773';

export const FEATURED_TOKENS = [
  { address: '0x4A0BCE713e45B09353AADf320AFB14B46e143b19', chainId: MAINNET_CHAIN_ID, name: 'Tether USD', symbol: 'USDT', decimals: 6,  tv: 'CRYPTO:USDTUSD', color: '#26A17B', kind: 'Stablecoin' },
  { address: '0x4d91Ee8E2071C4b79851ea912d9b2fC7efF79b8b', chainId: MAINNET_CHAIN_ID, name: 'USD Coin',   symbol: 'USDC', decimals: 6,  tv: 'CRYPTO:USDCUSD', color: '#2775CA', kind: 'Stablecoin' },
  { address: '0xCB8593e39fbAAe11d2dc6802B747AD4a2d48f7D9', chainId: MAINNET_CHAIN_ID, name: 'Bitcoin',    symbol: 'BTC',  decimals: 8,  tv: 'CRYPTO:BTCUSD',  color: '#F7931A', kind: 'Crypto' },
  { address: '0x49bB3e670AAD9F98fC93DB1940Ab24De163Fa935', chainId: MAINNET_CHAIN_ID, name: 'Ethereum',   symbol: 'ETH',  decimals: 18, tv: 'CRYPTO:ETHUSD',  color: '#627EEA', kind: 'Crypto' },
  { address: '0x5de1ba116Ee5445959C18Ac6DB7c3c11fba08f03', chainId: MAINNET_CHAIN_ID, name: 'TRON',       symbol: 'TRX',  decimals: 6,  tv: 'CRYPTO:TRXUSD',  color: '#EF0027', kind: 'Crypto' },
  { address: '0x5863395c2FaC8E26B0Cb4b6e7cFcd8800D37398f', chainId: MAINNET_CHAIN_ID, name: 'Solana',     symbol: 'SOL',  decimals: 9,  tv: 'CRYPTO:SOLUSD',  color: '#9945FF', kind: 'Crypto' },
  { address: '0x70AC68b7B679B55a1a3e8928A3C04Ad65b7aD6C8', chainId: MAINNET_CHAIN_ID, name: 'Gold',       symbol: 'XAU',  decimals: 18, tv: 'TVC:GOLD',       color: '#D4AF37', kind: 'Commodity' },
];

// Featured tokens only exist on the chain they were deployed to. The testnet
// explorer runs the same image, so filter by the live chainId or it would
// advertise mainnet tokens that don't exist here.
export function featuredFor(chainId) {
  return FEATURED_TOKENS.filter(t => String(t.chainId) === String(chainId));
}

export function findFeatured(addr, chainId) {
  if (!addr) return null;
  const a = String(addr).toLowerCase();
  return FEATURED_TOKENS.find(t =>
    t.address.toLowerCase() === a &&
    (chainId == null || String(t.chainId) === String(chainId))) || null;
}

// Dynamically mount any TradingView embed widget (their <script> config is
// read from the script's text; injecting via innerHTML won't run, so build
// the element).
export function mountTvWidget(host, srcFile, config) {
  if (!host || host.dataset.tvMounted) return;
  host.dataset.tvMounted = '1';
  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.height = '100%';
  host.appendChild(widget);
  const s = document.createElement('script');
  s.type = 'text/javascript';
  s.async = true;
  s.src = 'https://s3.tradingview.com/external-embedding/' + srcFile;
  s.text = JSON.stringify(config);
  host.appendChild(s);
}
