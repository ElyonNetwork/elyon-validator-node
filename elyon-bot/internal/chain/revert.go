package chain

import (
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/rpc"

	"github.com/elyon-chain/elyon-bot/internal/errs"
)

// RevertContext gives the error mapper the words it needs ("symbol" = the token being spent).
type RevertContext map[string]string

var (
	// The Elyon node reports reverts as `error.data = "err: TOKEN: balance (supplied gas 50000000)"`.
	reElyonData = regexp.MustCompile(`(?s)^err:\s*(.*?)\s*(\(supplied gas \d+\))?$`)
	reGeneric   = regexp.MustCompile(`(?i)(?:execution reverted:?|reverted with reason string|reverted with reason:?|revert(?:ed)?:)\s*['"]?([^'"\n|]{3,160})`)
)

// RevertReason extracts a contract revert reason from an RPC error (Elyon text format, standard Error(string)
// data, or a message containing "execution reverted: …").
func RevertReason(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var de rpc.DataError
	if errors.As(err, &de) {
		switch d := de.ErrorData().(type) {
		case string:
			if r, ok := decodeRevertData(d); ok {
				return r, true
			}
			if m := reElyonData.FindStringSubmatch(strings.TrimSpace(d)); m != nil {
				r := strings.TrimSpace(m[1])
				if r == "" {
					r = "revert"
				}
				return r, true
			}
		}
	}
	msg := err.Error()
	if m := reGeneric.FindStringSubmatch(msg); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	if strings.Contains(strings.ToLower(msg), "execution reverted") || strings.Contains(msg, "VM execution error") {
		return "revert", true
	}
	return "", false
}

func decodeRevertData(d string) (string, bool) {
	d = strings.TrimSpace(d)
	if !strings.HasPrefix(d, "0x08c379a0") {
		return "", false
	}
	b, err := hex.DecodeString(d[2:])
	if err != nil {
		return "", false
	}
	r, err := abi.UnpackRevert(b)
	if err != nil {
		return "", false
	}
	return r, true
}

type rule struct {
	re   *regexp.Regexp
	code string
	msg  string
	hint string
}

// Rules mirror the website's messages (apps/web/src/lib/errors/friendly.ts and the futures/gas panels), extended
// with every require() string of the Elyon futures, limit-order and gas contracts.
var rules = []rule{
	{regexp.MustCompile(`PERP: quote stale|LIMIT: quote outside`), errs.QuoteExpired, "The signed price expired before the transaction was mined. Nothing was opened or closed.", "Retry the command; it fetches a fresh price."},
	{regexp.MustCompile(`PERP: bad signer|PERP: signature|PERP: quote (market|price)`), errs.QuoteExpired, "The exchange's signed price was not accepted. Nothing changed.", "Retry the command; it fetches a fresh price."},
	{regexp.MustCompile(`PERP: paused|LIMIT: paused|LIMIT: market paused`), errs.MarketPaused, "Futures trading is paused right now.", "Try again later. Closing positions and cancelling orders stay available."},
	{regexp.MustCompile(`PERP: market disabled|LIMIT: market disabled|LIMIT: unknown market`), errs.MarketCloseOnly, "This market is not open for new positions right now.", "Open positions can still be closed."},
	{regexp.MustCompile(`PERP: leverage|LIMIT: leverage`), errs.LeverageTooHigh, "The leverage is outside this market's limits.", "Use `elyon futures price <MARKET>` to see the maximum leverage."},
	{regexp.MustCompile(`PERP: too large|LIMIT: too large`), errs.TooLarge, "The position is larger than the 20,000 wUSDT limit per position.", "Lower the margin or the leverage."},
	{regexp.MustCompile(`PERP: insufficient maintenance|LIMIT: insufficient maintenance`), errs.LeverageTooHigh, "The leverage is too high: the margin would not cover the maintenance margin and the closing fee.", "Lower the leverage."},
	{regexp.MustCompile(`PERP: margin|LIMIT: margin below minimum|LIMIT: margin`), errs.InvalidOrder, "The margin is too small (the minimum is 1 wUSDT).", ""},
	{regexp.MustCompile(`PERP: size|LIMIT: size`), errs.InvalidOrder, "The position size is too small for this market.", "Raise the margin or the leverage."},
	{regexp.MustCompile(`TRIG: take-profit side|TRIG: stop-loss side|LIMIT: take-profit side|LIMIT: stop-loss side`), errs.TriggerInvalid, "The price moved past your take profit or stop loss before the order was filled; nothing was opened.", "Adjust the take profit / stop loss and retry."},
	{regexp.MustCompile(`TRIG: stop-loss beyond liquidation|LIMIT: stop-loss beyond liquidation`), errs.TriggerInvalid, "That stop loss is beyond the liquidation price, so the position would be liquidated before it triggers.", "Move the stop loss closer to the current price."},
	{regexp.MustCompile(`TRIG: take-profit vs stop-loss|LIMIT: take-profit vs stop-loss`), errs.TriggerInvalid, "The take profit must be on the profit side of the stop loss.", ""},
	{regexp.MustCompile(`TRIG: not trader|LIMIT: not trader|PERP: not owner`), errs.NotYours, "Only the wallet that opened this position or order can change or close it.", ""},
	{regexp.MustCompile(`TRIG: not open|PERP: not open|LIMIT: not open`), errs.AlreadyClosed, "This position or order is already closed (filled, cancelled, closed or liquidated).", ""},
	{regexp.MustCompile(`PERP: liquidatable`), errs.Liquidatable, "This position has reached its liquidation price and can no longer be closed by you; it is being liquidated.", ""},
	{regexp.MustCompile(`PERP: reduce size|PERP: remainder`), errs.InvalidOrder, "Choose a part smaller than the whole position, or close the whole position.", ""},
	{regexp.MustCompile(`PERP: insurance depleted`), errs.TxReverted, "The futures insurance pool cannot pay this profit right now.", "Contact Elyon support; your position stays open."},
	{regexp.MustCompile(`LIMIT: too many open orders`), errs.OrderLimitReached, "You already have 25 open limit orders, the maximum.", "Cancel one first: `elyon futures orders` then `elyon futures cancel <id>`."},
	{regexp.MustCompile(`LIMIT: expiry`), errs.InvalidOrder, "The expiry must be in the future and at most 90 days away.", ""},
	{regexp.MustCompile(`LIMIT: price`), errs.InvalidOrder, "Enter a valid limit price.", ""},
	{regexp.MustCompile(`LIMIT: balance`), errs.InsufficientBalance, "The wallet must hold the order's full cost (margin + fee) in wUSDT while the order is open.", "Send more wUSDT to the wallet or lower the margin."},
	{regexp.MustCompile(`LIMIT: allowance`), errs.InsufficientBalance, "wUSDT is not approved for the limit-order contract yet.", "Retry; elyon approves automatically."},
	{regexp.MustCompile(`GAS: paused`), errs.GasSaleUnavailable, "Buying ELN for gas is paused right now. Please try again later.", ""},
	{regexp.MustCompile(`GAS: amount outside limits`), errs.InvalidInput, "This amount is outside the purchase limits.", "Run `elyon gas price` to see the limits."},
	{regexp.MustCompile(`GAS: daily limit reached`), errs.DailyLimit, "This wallet has reached its daily limit for buying ELN. It resets at 00:00 UTC.", ""},
	{regexp.MustCompile(`GAS: cost above maxCost`), errs.PriceMoved, "The price changed while the purchase was being sent.", "Run the command again."},
	{regexp.MustCompile(`GAS: not enough ELN inventory`), errs.GasSaleUnavailable, "Not enough ELN is available right now. Try a smaller amount or come back later.", ""},
	{regexp.MustCompile(`GAS: quote transfer`), errs.InsufficientBalance, "The wUSDT payment did not go through.", "Check the wUSDT balance and retry."},
	{regexp.MustCompile(`(?i)INSUFFICIENT_OUTPUT_AMOUNT|EXCESSIVE_INPUT_AMOUNT|UniswapV2: K\b`), errs.PriceMoved, "The price moved more than your slippage allows, so nothing was traded.", "Retry, or allow a little more slippage with --slippage."},
	{regexp.MustCompile(`(?i)UniswapV2Router: EXPIRED`), errs.PriceMoved, "The trade's deadline passed before it was mined. Nothing was traded.", "Retry."},
	{regexp.MustCompile(`(?i)INSUFFICIENT_LIQUIDITY`), errs.NoRoute, "The pool does not have enough liquidity for this trade.", "Trade a smaller amount."},
	{regexp.MustCompile(`(?i)TOKEN: balance|TOKEN: burn exceeds balance|transfer amount exceeds balance|exceeds balance|WELN: insufficient balance`), errs.InsufficientBalance, "", "Lower the amount or send more of the token to this wallet."},
	{regexp.MustCompile(`(?i)TOKEN: allowance|insufficient allowance|WELN: insufficient allowance|TRANSFER_FROM_FAILED|TRIG: transfer|LIMIT: transfer|PERP: transfer`), errs.InsufficientBalance, "", "Check the balance; elyon approves tokens automatically, so retry once."},
	{regexp.MustCompile(`TOKEN: transfer to zero`), errs.InvalidInput, "Tokens cannot be sent to the zero address.", ""},
}

// MapRevert turns a revert reason into a plain English error.
func MapRevert(reason string, ctx RevertContext, label string) *errs.E {
	sym := ctx["symbol"]
	if sym == "" {
		sym = "token"
	}
	for _, r := range rules {
		if r.re.MatchString(reason) {
			msg := r.msg
			if msg == "" {
				if r.code == errs.InsufficientBalance && strings.Contains(strings.ToLower(reason), "allowance") || strings.Contains(reason, "TRANSFER_FROM_FAILED") || strings.Contains(reason, ": transfer") {
					msg = "The " + sym + " payment could not be taken: the balance or the approval is too low."
				} else {
					msg = "You do not hold enough " + sym + " for this amount."
				}
			}
			e := errs.New(r.code, msg).With("reason", reason)
			if r.hint != "" {
				e.Hint = r.hint
			}
			return e
		}
	}
	what := "this transaction"
	if label != "" {
		what = "the " + label + " transaction"
	}
	if reason == "" || reason == "revert" {
		return errs.Newf(errs.TxReverted, "The contract refused %s. This almost always means the amount is larger than your %s balance, or the wallet has no ELN for gas.", what, sym).With("reason", reason).WithHint("Check both with `elyon wallet balance` and try again.")
	}
	return errs.Newf(errs.TxReverted, "The contract refused %s: %s.", what, strings.TrimRight(reason, ". ")).With("reason", reason)
}
