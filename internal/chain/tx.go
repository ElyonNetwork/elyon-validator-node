package chain

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rpc"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// DefaultTip is used when the node does not suggest a priority fee (ElyonChain runs at about 2 gwei).
var DefaultTip = big.NewInt(2_000_000_000)

// TxRequest describes one transaction to sign and send.
type TxRequest struct {
	To    common.Address
	Data  []byte
	Value *big.Int
	// GasMulNum/GasMulDen/GasAdd buffer the estimate: limit = estimate×Num/Den + Add (defaults ×5/4 + 10 000).
	GasMulNum, GasMulDen, GasAdd uint64
	// GasFallback is used when the node cannot estimate for a reason that is not a revert (0 = fail instead).
	GasFallback uint64
	// GasLimit, when set, is used as is (no estimate): only for plain ELN transfers to a wallet.
	GasLimit uint64
	// Fees, when set, are used instead of fresh suggestions (so "send all ELN" can compute value = balance − fee).
	Fees *Fees
	// Label describes the transaction in errors and results ("approve wUSDT", "open position").
	Label string
	// Revert maps contract revert reasons to user errors (nil = generic mapping).
	Revert RevertContext
}

// TxResult is a mined transaction.
type TxResult struct {
	Label   string         `json:"label"`
	Hash    common.Hash    `json:"hash"`
	Block   uint64         `json:"block"`
	GasUsed uint64         `json:"gas_used"`
	FeeWei  *big.Int       `json:"-"`
	Fee     string         `json:"fee_eln"`
	Receipt *types.Receipt `json:"-"`
}

// Fees are the EIP-1559 fee caps used for a transaction.
type Fees struct {
	Tip    *big.Int
	FeeCap *big.Int
}

// SuggestFees returns the tip suggested by the node and a fee cap of 2×base fee + tip.
func (c *Client) SuggestFees(ctx context.Context) (Fees, error) {
	tip, err := c.Eth.SuggestGasTipCap(ctx)
	if err != nil || tip == nil || tip.Sign() <= 0 {
		tip = new(big.Int).Set(DefaultTip)
	}
	h, err := c.Eth.HeaderByNumber(ctx, nil)
	if err != nil {
		return Fees{}, wrapRPC(err)
	}
	base := h.BaseFee
	if base == nil {
		base = big.NewInt(0)
	}
	feeCap := new(big.Int).Add(new(big.Int).Mul(base, big.NewInt(2)), tip)
	return Fees{Tip: tip, FeeCap: feeCap}, nil
}

// EstimateGas simulates the transaction and returns the buffered gas limit. A revert becomes a friendly error and
// nothing is sent.
func (c *Client) EstimateGas(ctx context.Context, from common.Address, req TxRequest) (uint64, error) {
	value := req.Value
	if value == nil {
		value = new(big.Int)
	}
	est, err := c.Eth.EstimateGas(ctx, ethereum.CallMsg{From: from, To: &req.To, Data: req.Data, Value: value})
	if err != nil {
		if reason, ok := RevertReason(err); ok {
			return 0, MapRevert(reason, req.Revert, req.Label).Wrap(err)
		}
		if isFundsError(err) {
			return 0, notEnoughGas(nil, nil)
		}
		if req.GasFallback > 0 {
			return req.GasFallback, nil
		}
		return 0, wrapRPC(err)
	}
	num, den, add := req.GasMulNum, req.GasMulDen, req.GasAdd
	if num == 0 || den == 0 {
		num, den, add = 5, 4, 10_000
	}
	return est*num/den + add, nil
}

// Send estimates, checks the ELN needed for gas, signs with key, sends and waits for the receipt. A reverted
// transaction returns TRANSACTION_REVERTED with the contract's reason in plain English.
func (c *Client) Send(ctx context.Context, key *ecdsa.PrivateKey, req TxRequest, timeout time.Duration) (*TxResult, error) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	from := crypto.PubkeyToAddress(key.PublicKey)
	value := req.Value
	if value == nil {
		value = new(big.Int)
	}
	gas := req.GasLimit
	if gas == 0 {
		var err error
		if gas, err = c.EstimateGas(ctx, from, req); err != nil {
			return nil, err
		}
	}
	var fees Fees
	if req.Fees != nil {
		fees = *req.Fees
	} else {
		var err error
		if fees, err = c.SuggestFees(ctx); err != nil {
			return nil, err
		}
	}
	bal, err := c.NativeBalance(ctx, from)
	if err != nil {
		return nil, err
	}
	need := new(big.Int).Mul(new(big.Int).SetUint64(gas), fees.FeeCap)
	need.Add(need, value)
	if bal.Cmp(need) < 0 {
		return nil, notEnoughGas(bal, need).With("address", from.Hex())
	}
	nonce, err := c.Eth.PendingNonceAt(ctx, from)
	if err != nil {
		return nil, wrapRPC(err)
	}
	to := req.To
	tx := types.NewTx(&types.DynamicFeeTx{ChainID: c.ChainID, Nonce: nonce, GasTipCap: fees.Tip, GasFeeCap: fees.FeeCap, Gas: gas, To: &to, Value: value, Data: req.Data})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(c.ChainID), key)
	if err != nil {
		return nil, errs.New(errs.Internal, "Could not sign the transaction.").Wrap(err)
	}
	if err := c.Eth.SendTransaction(ctx, signed); err != nil {
		return nil, mapSendError(err, req.Label)
	}
	return c.WaitMined(ctx, signed.Hash(), req, timeout)
}

// WaitMined polls for the receipt of hash (1 s interval) until timeout.
func (c *Client) WaitMined(ctx context.Context, hash common.Hash, req TxRequest, timeout time.Duration) (*TxResult, error) {
	deadline := time.Now().Add(timeout)
	for {
		rec, err := c.Eth.TransactionReceipt(ctx, hash)
		if err == nil && rec != nil {
			res := &TxResult{Label: req.Label, Hash: hash, Block: rec.BlockNumber.Uint64(), GasUsed: rec.GasUsed, Receipt: rec}
			if rec.EffectiveGasPrice != nil {
				res.FeeWei = new(big.Int).Mul(rec.EffectiveGasPrice, new(big.Int).SetUint64(rec.GasUsed))
				res.Fee = amount.Format(res.FeeWei, 18)
			}
			if rec.Status != types.ReceiptStatusSuccessful {
				reason := c.replayReason(ctx, hash, rec)
				var e *errs.E
				if reason != "" {
					// Keep the specific code (QUOTE_EXPIRED, PRICE_MOVED…) so bots know whether a retry helps.
					e = MapRevert(reason, req.Revert, req.Label).With("reverted_on_chain", true)
				} else {
					e = errs.Newf(errs.TxReverted, "The %s transaction was mined but reverted; nothing changed except the network fee.", labelOr(req.Label, "")).WithHint("Run the command again; if it keeps failing, check balances and inputs.")
				}
				return res, e.With("tx", hash.Hex())
			}
			return res, nil
		}
		if err != nil && !errors.Is(err, ethereum.NotFound) && !isPrunedPending(err) {
			// transient RPC trouble: keep waiting until the deadline
		}
		if time.Now().After(deadline) {
			return &TxResult{Label: req.Label, Hash: hash}, errs.Newf(errs.TxPending, "The %s transaction %s was sent but is not confirmed yet.", labelOr(req.Label, ""), hash.Hex()).
				WithHint("It may still be mined. Check it with `elyon tx "+hash.Hex()+"` before sending it again.").With("tx", hash.Hex())
		}
		select {
		case <-ctx.Done():
			return &TxResult{Label: req.Label, Hash: hash}, errs.Newf(errs.TxPending, "Stopped waiting for transaction %s; it may still be mined.", hash.Hex()).With("tx", hash.Hex())
		case <-time.After(time.Second):
		}
	}
}

// replayReason re-runs a reverted transaction as a call at its block to learn the revert reason.
func (c *Client) replayReason(ctx context.Context, hash common.Hash, rec *types.Receipt) string {
	tx, _, err := c.Eth.TransactionByHash(ctx, hash)
	if err != nil || tx == nil || tx.To() == nil {
		return ""
	}
	from, err := types.Sender(types.LatestSignerForChainID(c.ChainID), tx)
	if err != nil {
		return ""
	}
	_, err = c.Eth.CallContract(ctx, ethereum.CallMsg{From: from, To: tx.To(), Data: tx.Data(), Value: tx.Value(), Gas: tx.Gas()}, rec.BlockNumber)
	if err == nil {
		return ""
	}
	r, _ := RevertReason(err)
	return r
}

func isPrunedPending(err error) bool {
	var re rpc.Error
	if errors.As(err, &re) && re.ErrorCode() == 4444 {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "pruned history unavailable")
}

func isFundsError(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "insufficient funds") || strings.Contains(m, "intrinsic gas") || strings.Contains(m, "gas required exceeds")
}

func notEnoughGas(have, need *big.Int) *errs.E {
	e := errs.New(errs.NotEnoughGas, "Not enough ELN to pay the network fee.")
	if have != nil && need != nil {
		e.Message = fmt.Sprintf("Not enough ELN to pay the network fee: this needs up to %s ELN and the wallet holds %s ELN.", amount.FormatSig(need, 18, 6), amount.FormatSig(have, 18, 6))
		e.With("needed_eln", amount.Format(need, 18)).With("balance_eln", amount.Format(have, 18))
	}
	return e.WithHint("Send a little ELN to this wallet (0.1 ELN pays for hundreds of trades), or buy some with wUSDT: `elyon gas buy 0.5`.")
}

func mapSendError(err error, label string) error {
	m := strings.ToLower(err.Error())
	switch {
	case isFundsError(err):
		return notEnoughGas(nil, nil).Wrap(err)
	case strings.Contains(m, "nonce too low") || strings.Contains(m, "already known") || strings.Contains(m, "replacement transaction underpriced") || strings.Contains(m, "nonce has already been used"):
		return errs.New(errs.NonceConflict, "Another transaction from this wallet is still pending.").WithHint("Wait a few seconds for it to be mined, then retry. Do not use the same key in two programs at once.").Wrap(err)
	}
	if reason, ok := RevertReason(err); ok {
		return MapRevert(reason, nil, label).Wrap(err)
	}
	return errs.Newf(errs.TxRejected, "The network refused the %s transaction: %s", labelOr(label, ""), firstLine(err.Error())).Wrap(err)
}

func labelOr(l, d string) string {
	if l == "" {
		return d
	}
	return l
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}
