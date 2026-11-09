# Fees and rewards

ELN is the native token of Elyon Chain. It pays gas, is staked by validators and is what the registry
pays out. There is no block subsidy: the chainspec sets `reward` to zero, so everything participants
earn comes from transaction fees and from staking packages funded by the network.

## How a transaction fee is split

Fees follow EIP-1559, then APOS settles them inside the same block:

```
gasUsed × effectiveGasPrice
├── base fee × gasUsed      → burned
└── priority fee × gasUsed  → moved from the block producer to the UNPRegistry contract
     ├── relaying validator  → tier share (gasShareBps / 10000), if the tx carries a valid attestation
     └── network treasury    → the rest
```

| Step | Detail | Code |
|---|---|---|
| Fee captured | After the block's transactions run, the priority fee of each one moves to the registry | `APOSFeeDistributor.Apply` |
| Attribution | The block's `extraData` can carry `URELAY1` records. Each names the node that received a transaction, signed by that node's key | `RelayerAttestation.cs` |
| Credit | If that node is `ACTIVE` in the registry, its `accumulatedFees` grows by its tier share in the same block | `APOSFeeDistributor.Apply` |
| Rest | Any remainder, and transactions without a valid attestation, go to `adminAccumulatedFees` | `APOSFeeDistributor.Apply` |

Because this happens during block processing and is included in the state root, every node computes it
identically and there is no separate settlement transaction. The block producer keeps nothing from a
transaction it sealed: producing blocks is a service, and income comes from relaying and staking.

The accrued amounts are withdrawn with a normal transaction: `withdrawValidatorFees()` for operators.

> The attestation format is a claim by the relaying node, signed with its own key. It is effective for
> honest operation and pays only `ACTIVE` validators, but a registered validator could attest a
> transaction it did not relay. See open item ATT-1 in [SECURITY.md](../SECURITY.md).

## How an operator earns

| Source | How it is earned | Where it is set |
|---|---|---|
| Relay fee share | A share of the priority fee of every transaction sent through the node's RPC | Admin-set tier curve, driven by the operator's pool (own stake plus delegations) |
| Staking package APR | Yield on the operator's own stake, accrued daily | Packages published by the admin |
| Delegation spread | Delegators stake through the operator's packages; the operator publishes their terms, capped at its own package APR | The operator |

To register: run a node (see [NODE-SETUP.md](NODE-SETUP.md)), apply in the dashboard with a staking
package, and be approved by the network admin. Status values are `NONE`, `PENDING`, `ACTIVE`, `REJECTED`,
`SUSPENDED` and `BELOW_MIN` (the pool fell under the minimum; restored automatically when it recovers).

No staking packages are published on mainnet yet, so the APR and delegation parts above are not yet in
use there.

## Validators (block producers)

Block production is a separate role from relay earnings, gated by the staking contract:

| Item | Value |
|---|---|
| Minimum stake | 100,000 ELN when entry is open; [entry is currently paused](DECENTRALIZATION.md#why-validator-entry-is-paused) |
| Unbonding delay | 100 blocks |
| Reward for producing a block | None |
| Slashing | Not implemented |

## Gas parameters on mainnet

| Parameter | Value |
|---|---|
| Fee market | EIP-1559 |
| Minimum accepted gas price | 1 gwei (enforced at the node's RPC) |
| Block gas limit | 50,000,000 |
| Block time | 2 seconds |
