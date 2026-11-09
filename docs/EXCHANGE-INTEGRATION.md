# Integrating Elyon Chain (exchanges and custodians)

Elyon Chain speaks standard Ethereum JSON-RPC, so an integration built for an EVM chain works with the
parameters below.

## Network parameters

| | Mainnet |
|---|---|
| Chain ID | `55452773` (hex `0x34E2465`) |
| Native token | **ELN**, 18 decimals |
| Public RPC | `https://mainnet.elyon.network/rpc` |
| Explorer | `https://explorer.elyon.network` |
| Live blocks | `https://blocks.elyon.network` |
| Block time | 2 seconds |
| Gas pricing | EIP-1559. Minimum gas price 1 gwei |
| Block gas limit | 50,000,000 |
| Address format | Standard Ethereum 20-byte addresses with EIP-55 checksums |
| Signatures | secp256k1 with EIP-155 replay protection |

For production, run your own node: [NODE-SETUP.md](NODE-SETUP.md).

## Deposits

Native ELN transfers are normal value transfers. To detect deposits, read each block with
`eth_getBlockByNumber(n, true)` and match `to` against your deposit addresses. Confirm the outcome with
`eth_getTransactionReceipt` (`status == 1`). Contract-based transfers must be read from receipts and
logs, as on any EVM chain.

### Confirmations

Elyon has no finality gadget; a block gets safer with each block on top of it (see
[CONSENSUS.md](CONSENSUS.md)). Recommended starting point:

| Deposit size | Confirmations | Time at 2 s/block |
|---|---|---|
| Standard | 30 | about 1 minute |
| Large | 120 | about 4 minutes |

Run your node with direct connections to multiple peers, and alert if the head stops advancing or
blocks reorganise deeper than two.

## Withdrawals

Sign EIP-1559 (type 2) or legacy transactions with chain ID `55452773` and broadcast them with
`eth_sendRawTransaction`. Fetch a nonce with `eth_getTransactionCount(address, "pending")`. Native
transfers use 21,000 gas. Fees are paid in ELN.

## Supported JSON-RPC

The public RPC allows `eth_`, `net_` and `web3_` methods only. Administrative namespaces (`admin_`,
`debug_`, `personal_`) are not exposed. A JSON-RPC batch must contain request objects, up to 50 per batch.
