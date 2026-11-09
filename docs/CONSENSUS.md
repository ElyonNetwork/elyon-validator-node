# Consensus: how Elyon Chain forms blocks

Elyon Chain runs **APOS**, a proof-of-stake engine implemented as a Nethermind consensus plugin
(`src/Nethermind/Nethermind.Consensus.PoS`). This page describes what the code does today.

| Parameter | Mainnet value | Where it is set |
|---|---|---|
| Chain ID | `55452773` | chainspec |
| Target block time | 2 seconds | `engine.pos.params.period` |
| Validator set | `activeValidators` in the staking contract | `0x04250541308a1d1c633de3d435e361402505cf29` |
| Minimum stake | 100,000 ELN (see [DECENTRALIZATION.md](DECENTRALIZATION.md) for how entry is currently managed) | staking contract |
| Unbonding | 100 blocks | staking contract constant |
| Block reward | None. Validators and relayers are paid from transaction fees | chainspec `reward: 0x0` |

## Validators

The validator set is the `activeValidators` array of the staking contract, read directly from
contract storage at the parent block's state. Every node computes the same set from chain state;
no off-chain list is involved. Adding a validator means staking into that contract: the validator
joins the rotation from the next block after its stake transaction.

## Rotation

The proposer for block `n` is `activeValidators[n mod N]`.

* The **in-turn** validator seals at parent time + 2 seconds with difficulty **2**.
* If it misses its slot, the **next validators step in one at a time**: the validator `d` places
  after the in-turn one becomes eligible at parent time + 10 seconds + `(d - 1) × 2` seconds, and
  seals with difficulty **1**. One absent validator therefore costs one slow block per round, not a
  halt, and two validators stepping in at the same moment is avoided by construction.
* The fork-choice rule is the highest total difficulty, so an in-turn block beats a backup block
  built at the same height.

Each block carries the seal (a secp256k1 signature over the block header without the seal bytes) in
the last 65 bytes of `extraData`, in the same layout as Clique. Every node verifies it.

## Block validity rules

| Rule | Where | Active from |
|---|---|---|
| Seal is a valid signature and the signer is in the validator set at the parent state | `PoSSealValidator` | Network start |
| Proposer order: an out-of-turn signer needs a 10-second gap from the parent | `PoSSealValidator` | Network start |
| Difficulty must be exactly 2 (in turn) or 1 (out of turn) | `PoSSealValidator` | Hardening block |
| Minimum 2 seconds between a block and its parent | `PoSSealValidator` | Hardening block |
| Timestamp at most 15 seconds ahead of local clock | `PoSSealValidator` | Hardening block |
| Signer re-checked just before execution, against the state of the parent block | `BlockProcessor` pre-check | Hardening block |
| State root, transactions root, receipts root and gas accounting | Nethermind block validation | Network start |

The **hardening block** is `engine.pos.params.hardeningBlock` in the chainspec, block 5,730,400 on mainnet, just before the first additional validator joined. Earlier blocks are
validated exactly as they were when produced, so a fresh node can replay the chain from genesis.

## Finality

Elyon Chain has no finality gadget. As in Clique, a block becomes harder to replace with every block
built on top of it, and honest validators extend the heaviest chain. With a known validator set of
seven, a one-block reorganisation can only happen when a validator misses a slot. Exchanges should
wait for confirmations before crediting deposits; see
[EXCHANGE-INTEGRATION.md](EXCHANGE-INTEGRATION.md).

## What this engine does not do

* There is **no slashing** and no automatic removal of an offline validator. A validator that stops
  producing only slows the chain by its own slot each round until it requests unstake.
* There is no finality gadget or BFT voting.
* Nothing is anchored to Ethereum or any other chain. See [LAYER-2.md](LAYER-2.md).
