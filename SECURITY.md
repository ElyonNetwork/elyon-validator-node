# Security

This document records the security review carried out on Elyon Chain in November 2026: what was
reviewed, what was found, what was fixed and what remains open. It is the Elyon team's own review, not
an audit by an independent firm. An independent audit is still recommended.

To report a vulnerability, please do not post technical details publicly. Open an issue titled
"Security contact request", without details, and the team will arrange a private channel.

## Scope

| Component | Reviewed |
|---|---|
| Consensus engine (`Nethermind.Consensus.PoS`) | Block validation, proposer rules, fork choice inputs, sync path |
| Fee settlement hook and relayer attestations | Determinism, accounting, attribution, P2P message handling |
| Node dashboard and JSON-RPC proxy (`dashboard/`) | Every route, authentication, method allowlist, rate limits, key handling, file and network access |
| Smart contracts (`contracts/`) | Staking, registry and pointer. The deployed bytecode matches this source |
| Public infrastructure | Reverse proxy rules, exposed ports |

Consensus changes are switched on at a block number in the chainspec (`hardeningBlock`). Blocks before
it replay exactly as they were produced.

## Findings and status

Severity is ours: **Critical** means remote key theft or control of the chain; **High** means a remote
crash, a loss of funds or a route to one.

### Consensus

| ID | Severity | Finding | Status |
|---|---|---|---|
| CON-1 | Critical | Block difficulty was not checked, so a validator could outweigh the chain in fork choice | Fixed: difficulty must be exactly 2 or 1 by turn |
| CON-2 | High | A single validator could stamp a block far in the future, stalling production until that time | Fixed: blocks more than 15 s ahead of local time are rejected, minimum 2 s spacing |
| CON-3 | High | Validators built blocks out of turn at the normal rate, and a validator that joined but stayed offline could split other nodes from the chain | Fixed: only the in-turn validator builds at the normal rate; backups step in one by one after 10 s |
| CON-4 | High | An oversized validator array, or a validator set that could not be read, disabled the signer check | Fixed: the set is capped at 256 and read per block at the parent state |
| CON-5 | Medium | During sync, signer checks were deferred and never re-run | Fixed: each block's signer is checked again immediately before execution |
| CON-6 | High | While catching up, a node could reject a validator that had joined after its current position, because the seal check used a cached validator list, and stop syncing | Fixed: from the hardening block that check uses the block's own parent state, before execution |

### Fee settlement and networking

| ID | Severity | Finding | Status |
|---|---|---|---|
| FEE-1 | Critical | Fee claims could be booked in the registry for fees that never reached it | Fixed: a claim is booked only when the fee has moved to the registry |
| FEE-2 | Medium | A failure inside the fee hook could leave partial credits | Fixed: the hook's changes are rolled back as a unit on failure |
| NET-1 | High | Unlimited attestation messages could exhaust a node's memory | Fixed: bounded pool |
| NET-2 | High | A small malformed P2P message could stall the network thread and use large amounts of memory | Fixed: strict limit and single-pass parsing |
| NET-3 | High | With a large attestation backlog, the pool's size check took every internal lock once per second and starved the thread pool. Found during the November 2026 rollout, when it slowed block processing on the main node for about seven minutes | Fixed: lock-free counter, and files already handled are skipped. Rollback was immediate and no blocks were lost |

### Node dashboard and JSON-RPC

| ID | Severity | Finding | Status |
|---|---|---|---|
| RPC-1 | Critical | A nested JSON-RPC batch bypassed the method allowlist and reached the node unfiltered | Fixed at the edge and in the node |
| RPC-2 | High | The validator key was on the client's command line, readable through config RPC, and administrative RPC modules were enabled | Fixed: the key reaches the client only through its process environment at start-up; `debug`, `personal` and `clique` modules and the dev wallet are off |
| RPC-3 | High | Attestations were written for any payload and an open endpoint accepted them | Fixed: only parsed, node-accepted transactions are attested; the endpoint verifies signatures and is rate-limited |
| RPC-4 | High | A malformed login could crash the dashboard | Fixed |
| RPC-5 | High | RPC on the dashboard port had no rate limit | Fixed |
| RPC-6 | Medium | All clients shared one rate-limit bucket behind the proxy | Fixed |
| RPC-7 | Medium | Configuration writes were not atomic, and an unreadable config failed open | Fixed |
| RPC-8 | Medium | Public feedback uploads had no limits; request bodies up to 50 MB were parsed on every path | Fixed |
| RPC-9 | Medium | Two dashboard proxies were open relays | Fixed: allowlists |
| RPC-10 | Medium | Expensive public read routes had no throttle | Fixed: per-client limits on the dashboard API, lower on expensive routes |
| RPC-11 | Medium | The delegation desk rewrote a file on every call with no size limit | Fixed: held in memory, saved in the background and capped |
| RPC-12 | Medium | Admin passwords could be 4 characters and the session cap could be bypassed | Fixed: 12-character minimum, and every login goes through the capped session store |
| RPC-13 | Medium | Validator keystore files were world-readable on the host | Fixed: owner-only permissions, applied to existing files at start-up |
| RPC-14 | Low | A status route exposed internal paths, and unhandled route errors could reach the default error page | Fixed |
| RPC-15 | Medium | The public portal offers pasting a private key as a fallback, and the server then signs with it | **Open.** A browser wallet is the recommended path and signs locally. Moving every action to browser signing is planned |
| RPC-16 | Medium | Delegation desk messages carry no wallet proof of identity | **Open.** The desk is not yet in use on mainnet |
| RPC-17 | Medium | The passphrase protecting the stored validator key sits on the same volume as the key | **Open.** Host access is the security boundary until a separate secret store is added |
| RPC-18 | Low | Checks that refuse private addresses on admin-only URL fetches have gaps | **Open.** These routes require an admin session |

### Smart contracts

| ID | Severity | Finding | Status |
|---|---|---|---|
| SC-1 | High | One key is the admin of the staking contract, registry and pointer, seals blocks and holds most of the supply | **Open.** Requires moving the treasury to cold storage and multi-signature control |
| SC-2 | High | Once staking packages exist, a withdrawal can revert if the reward pool cannot pay accrued profit, fees can be lost if an exit runs in the wrong order, and package limits can be bypassed | **Open.** No staking packages exist on mainnet; the registry must be fixed before any are added |
| SC-3 | Medium | A registry upgrade through the pointer would not be checked for storage layout | **Open.** Operational rule: a registry upgrade ships together with a node release |
| SC-4 | Medium | The staking contract cannot remove a validator and has no slashing | **Mitigated.** New validator entry is paused until an eviction path exists |
| SC-5 | Medium | The admin can shorten the pointer's 24-hour change delay to 1 hour with immediate effect | **Open.** To be closed with the move to multi-signature control |

### Attribution model

| ID | Severity | Finding | Status |
|---|---|---|---|
| ATT-1 | Medium | The relayer attestation proves which node claims a transaction, not who received it first; a registered validator could over-claim | **Open.** Only `ACTIVE` validators are paid, and registration is admin-approved |

## Challenges of this type of chain

| Challenge | How Elyon addresses it |
|---|---|
| Key exposure on public infrastructure | Node RPC is allowlisted to `eth_`, `net_` and `web3_`, administrative modules are off, keys are encrypted at rest and never placed on a command line |
| Denial of service through RPC | Per-client rate limits, batch limits and body size limits at the proxy and the node |
| Denial of service through P2P | Size and count limits on Elyon's custom message, bounded pools |
| Consensus manipulation by a validator | Strict block rules (difficulty, spacing, timestamps) enforced by every node |
| A validator going offline | Backup validators step in after a fixed delay; verified with validators stopped on a test network |
| State divergence between nodes | Fee settlement is deterministic and part of the state root; a node that computes a different result rejects the block |
| Replay across networks | EIP-155 chain ID in transactions; attestations signed over the chain ID |
| Dependence on a single operator | Seven validators on separate machines; still one team, see [DECENTRALIZATION.md](docs/DECENTRALIZATION.md) |

A small number of low-severity items also remain: constant-time secret comparison in the bridge mode, which is off on mainnet; a legacy testnet faucet route; and contracts that are not deployed on mainnet.

## What was not done

* No independent third-party audit has been performed.
* The bridge and the DEX are separate systems and were not part of this review.
* There is no formal verification of the contracts.
