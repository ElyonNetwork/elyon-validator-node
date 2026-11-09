# Decentralization status

This page states plainly how decentralized Elyon Chain is today and what would change that. The numbers
below can be checked by anyone against the chain and [blocks.elyon.network](https://blocks.elyon.network).

## Block production

| Fact | Value | How to verify |
|---|---|---|
| Consensus | APOS proof of stake with a fixed rotation (see [CONSENSUS.md](CONSENSUS.md)) | Source code |
| Validators producing blocks on mainnet | **7** | `eth_getStorageAt` on the staking contract, or blocks.elyon.network |
| Who operates them today | **The Elyon team operates all seven** | Stated here; the addresses are listed below |
| Where they run | 7 separate machines, each signing with its own key | Each address below signs its own blocks |
| Fault tolerance | The chain keeps producing with validators offline. Each offline validator costs one slow block (10 seconds) per rotation | Tested with validators stopped |

## Validator addresses

| Node | Address |
|---|---|
| Elyon Node 1 (main) | `0xe26F1a776778912C3747F6fd240b573cd57b5601` |
| Elyon Node 2 | `0x040c6bDb771B8A4fB72e62C184E8AC013eD50bee` |
| Elyon Node 3 | `0x2D91cD6a1B991c5818F0f69CbFeA2Db96C783954` |
| Elyon Node 4 | `0xc2B720d18154D891E6BAC2ff1E8101c79eACB892` |
| Elyon Node 5 | `0x3eea271074A404Fc03CA213C01dD8Bed9E5192B6` |
| Elyon Node 6 | `0xf842cE0423aC59a6Af8f441627801c9dcE04671a` |
| Elyon Node 7 | `0xE3eB959C53F130D955b24ba2Ea8cC448bFa186a8` |

## What is open and what is not

| Area | State |
|---|---|
| Source code | Public in this repository |
| Running a full node | Open to anyone; see [NODE-SETUP.md](NODE-SETUP.md) |
| Running an RPC node that earns relay fees | Open, subject to registry approval by the admin |
| Becoming a block-producing validator | The staking contract is open by design, but entry is **currently paused by the network admin** (see below) |
| Protocol changes | Decided and shipped by the Elyon team |
| Admin keys | One hot key is the admin of the staking contract, the registry and the pointer. Rotating this to multi-signature control is an open item in [SECURITY.md](../SECURITY.md) |

### Why validator entry is paused

The staking contract can add a validator but cannot remove one, and the protocol does not yet slash a
validator that misbehaves. A staker could join and stay offline, adding a permanent 10-second delay per
rotation that nobody could remove. Until the protocol has an eviction or slashing path, the admin keeps
the contract's minimum stake parameter at its maximum value, which blocks new stakes while leaving the
seven validators and their stakes untouched. Reopening takes one on-chain transaction by the admin.

## Honest summary

Elyon Chain today runs on seven validators that are operated by one team. That is better than a single
node for availability and for tolerating failures, but it is **not yet decentralized in the sense of
independent operators**, and the admin key has broad powers. The realistic next steps are:

1. Add slashing or automatic removal, so that validator entry can be reopened safely.
2. Move admin rights to a multi-signature wallet with a public timelock.
3. Onboard validators operated by independent parties.
