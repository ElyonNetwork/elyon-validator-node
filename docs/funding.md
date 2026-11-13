# Fund your bot wallet

Your bot trades with its **own** wallet — the one the client created on your computer. It needs two things in that wallet:

| what | why | how much to start |
|---|---|---|
| **wUSDT** | the money your bot trades with (spot and futures margin) | whatever you want the bot to trade, start small |
| **ELN** | ElyonChain's gas: every order, approval and transfer pays a tiny ELN fee | 0.5 ELN lasts for hundreds of orders |

There is no special deposit for bots. You use ElyonDex exactly as usual, then send the funds from your ElyonDex wallet to your bot's address.

## 1. Find your bot's address

On the computer where the client runs:

```bash
elyon wallet address
```

It prints an address that starts with `0x`. Copy all of it. You can paste it into any ElyonChain wallet — it is a normal ElyonChain address.

> **Tip:** always copy the address from the client itself, never from a chat or an old message, and check the first and last six characters after pasting.

## 2. Get wUSDT on ElyonDex

1. Open [dex.elyon.network](https://dex.elyon.network) and connect your usual wallet with **Connect wallet** (Reown).
2. Open **Bridge → Deposit** and choose the network you send USDT from (BNB Smart Chain, Ethereum or Tron).
3. Send USDT to the deposit address the page shows. After the confirmations, the same amount (minus the network fee shown on the page) arrives as **wUSDT** in your ElyonDex wallet.

The minimum deposit is 2 USDT on BNB Smart Chain, 8 on Tron and 20 on Ethereum.

## 3. Get a little ELN for gas

If your ElyonDex wallet has no ELN yet, open **ELN → Buy ELN for gas** and buy a small amount (it is paid in wUSDT at a fixed
price). Your first deposit of 10 USDT or more may also come with a small ELN gift for gas. ELN itself is not traded in the
spot markets until its exchange listing, so the gas page is the way to get it.

Later, when the bot runs low on gas, it can buy ELN by itself with wUSDT — exactly the website's gas page:

```bash
elyon gas buy 0.5
```

## 4. Send both to your bot

In your wallet app (MetaMask, Trust Wallet, or the wallet you connected through Reown), on the **ElyonChain** network:

1. Send the wUSDT amount you want the bot to trade to your bot's address.
2. Send about 0.1–0.5 ELN to the same address (0.1 ELN pays for hundreds of orders).

Then check on the client:

```bash
elyon wallet balance
```

You should see your ELN and wUSDT. Your bot is ready.

## Taking money out again

Your bot's wallet is yours. To move funds back to your normal wallet, use the client's send command (it asks for your password, or the destination must be on your approved list):

```bash
elyon wallet send 100 wUSDT to 0xYourNormalWalletAddress
```

From your normal wallet you can withdraw to BNB Smart Chain, Ethereum or Tron through **Bridge → Withdraw** on ElyonDex, as usual.

> **Note:** everything the client does happens on ElyonChain only. It never sends anything to another network; deposits and withdrawals to other networks always go through ElyonDex.
