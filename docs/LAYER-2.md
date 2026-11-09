# What "Layer 2" means on Elyon Chain

Elyon documents its system in two layers. This page says exactly what each one is, because the term
"Layer 2" means different things in different projects.

## The two layers

**Layer 1: EVM execution.** Elyon Chain is an EVM-compatible chain with its own validators and its own
consensus. It is a fork of the [Nethermind](https://github.com/NethermindEth/nethermind) Ethereum
client. Transactions, gas, signatures and JSON-RPC behave like Ethereum, so existing wallets and
tools work unchanged.

**Layer 2: APOS settlement.** On top of execution, APOS runs inside block processing, after the
transactions of a block have executed and before its state root is computed. It settles fees:

1. **Fee capture.** The priority fee of every transaction is moved from the block producer to the
   `UNPRegistry` contract. The base fee is burned, as in EIP-1559.
2. **Relayer attribution.** Each transaction can carry a signed attestation (`URELAY1`, stored in the
   block's `extraData`) naming the RPC node that received it. If that node is an active validator in
   the registry, it is credited its tier share of that transaction's priority fee. The rest is
   credited to the network treasury.
3. **Same block.** The credits are ordinary contract storage writes made in the same block. Because
   they are part of the state root, every node must compute them identically, or it rejects the block.

There is no off-chain settlement service, no batch job and no claim transaction for the accrual
itself. Operators withdraw their accrued balance from the registry when they want to.

## What Elyon is not

* **Elyon is not a rollup.** It does not post transaction data or state roots to Ethereum or any other
  chain, and it does not inherit another chain's security. Security comes from Elyon's own validators.
* **There is no bridge-based L2 trust model** behind the chain itself. Bridged assets such as wUSDT
  are issued by a gateway service, which is a separate trust assumption described with the DEX.

A precise short description is: *an independent EVM proof-of-stake chain with a consensus-level fee
settlement layer that pays RPC operators for the transactions they relay.*

## The native token

**ELN** is the chain's native token and default gas currency, with 18 decimals. Fees, validator stakes
and registry balances are denominated in ELN.
