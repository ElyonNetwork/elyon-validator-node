// Centralised runtime config. All values come from env so docker-compose can
// override anything without rebuilding the image.
export const config = {
  port:       parseInt(process.env.PORT || '8080', 10),
  rpcUrl:     process.env.RPC_URL     || 'https://operatortestnet.elyon.network/rpc',
  // Wallet-facing RPC URL advertised to MetaMask via wallet_addEthereumChain.
  // MetaMask rejects http:// URLs, but the indexer's RPC_URL must stay on the
  // raw http://IP:3000 origin to bypass Cloudflare Bot Fight Mode (which 403s
  // server-to-server calls to *.elyon.network). So keep them separate.
  publicRpcUrl: process.env.PUBLIC_RPC_URL || 'https://admintestnet.elyon.network/rpc',
  chainId:    parseInt(process.env.CHAIN_ID || '0', 10),     // 0 = autodetect from RPC
  chainName:  process.env.CHAIN_NAME  || 'Elyon Chain',
  nativeToken:{
    name:    process.env.NATIVE_NAME   || 'Elyon',
    symbol:  process.env.NATIVE_SYMBOL || 'ELN',
    decimals: parseInt(process.env.NATIVE_DECIMALS || '18', 10),
  },
  registryAddress: process.env.REGISTRY_ADDR || '', // UNPRegistry — optional
  pg: {
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    user:     process.env.PGUSER     || 'explorer',
    password: process.env.PGPASSWORD || 'explorer',
    database: process.env.PGDATABASE || 'elyon_explorer',
  },
  adminPassword: process.env.ADMIN_PASSWORD || '27437823',
  jwtSecret:     process.env.JWT_SECRET     || 'change-me-in-production-32-plus-chars-please',
  indexer: {
    enabled:   (process.env.INDEXER_ENABLED || 'true') !== 'false',
    batchSize: parseInt(process.env.INDEXER_BATCH || '10', 10),
    headLag:   parseInt(process.env.INDEXER_HEAD_LAG || '2', 10),
    pollMs:    parseInt(process.env.INDEXER_POLL_MS || '2000', 10),
  },
  // L2 fee distribution defaults (bps). Used when the on-chain registry
  // is unreachable. 1000 / 500 / 300 / 8200 = 10 % / 5 % / 3 % / residual.
  feeBps: {
    node:     parseInt(process.env.FEE_BPS_NODE     || '1000', 10),
    contract: parseInt(process.env.FEE_BPS_CONTRACT || '500',  10),
    token:    parseInt(process.env.FEE_BPS_TOKEN    || '300',  10),
  },
};
