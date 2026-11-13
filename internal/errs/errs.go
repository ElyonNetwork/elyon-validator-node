// Package errs defines the user-facing errors of elyon-bot: a stable machine code (for bots) and a plain English
// message (for humans). Every error that reaches the CLI or the HTTP API is an *E.
package errs

import (
	"errors"
	"fmt"
	"net/http"
)

// Stable error codes. Bots should branch on these, never on the message text.
const (
	InvalidInput        = "INVALID_INPUT"
	UnknownCommand      = "UNKNOWN_COMMAND"
	UnknownMarket       = "UNKNOWN_MARKET"
	AmbiguousMarket     = "AMBIGUOUS_MARKET"
	UnknownToken        = "UNKNOWN_TOKEN"
	WalletMissing       = "WALLET_MISSING"
	WalletLocked        = "WALLET_LOCKED"
	WrongPassword       = "WRONG_PASSWORD"
	PasswordRequired    = "PASSWORD_REQUIRED"
	PasswordExpired     = "PASSWORD_EXPIRED"
	PasswordWeak        = "PASSWORD_TOO_WEAK"
	TooManyAttempts     = "TOO_MANY_PASSWORD_ATTEMPTS"
	WalletTampered      = "WALLET_FILE_MODIFIED"
	TerminalRequired    = "TERMINAL_REQUIRED"
	BackupLocked        = "BACKUP_ALREADY_CONFIRMED"
	NotEnoughGas        = "NOT_ENOUGH_ELN_FOR_GAS"
	InsufficientBalance = "INSUFFICIENT_BALANCE"
	MarketClosed        = "MARKET_CLOSED"
	MarketCloseOnly     = "MARKET_CLOSE_ONLY"
	MarketPaused        = "MARKET_PAUSED"
	ElnNotTradable      = "ELN_NOT_TRADABLE"
	QuoteExpired        = "QUOTE_EXPIRED"
	QuoteUnavailable    = "PRICE_FEED_UNAVAILABLE"
	PriceMoved          = "PRICE_MOVED"
	PriceImpactTooHigh  = "PRICE_IMPACT_TOO_HIGH"
	PoolNotReady        = "POOL_NOT_READY"
	NoRoute             = "NO_ROUTE"
	InvalidOrder        = "INVALID_ORDER"
	TooLarge            = "POSITION_TOO_LARGE"
	LeverageTooHigh     = "LEVERAGE_TOO_HIGH"
	TriggerInvalid      = "TAKE_PROFIT_STOP_LOSS_INVALID"
	OrderLimitReached   = "TOO_MANY_OPEN_ORDERS"
	NotFound            = "NOT_FOUND"
	NotYours            = "NOT_YOURS"
	AlreadyClosed       = "ALREADY_CLOSED"
	Liquidatable        = "POSITION_LIQUIDATABLE"
	TxReverted          = "TRANSACTION_REVERTED"
	TxPending           = "TRANSACTION_PENDING"
	TxRejected          = "TRANSACTION_REJECTED"
	NonceConflict       = "NONCE_CONFLICT"
	TransferNotAllowed  = "TRANSFER_NOT_ALLOWED"
	DailyLimit          = "DAILY_LIMIT_REACHED"
	ContractMismatch    = "CONTRACT_MISMATCH"
	ChainMismatch       = "WRONG_CHAIN"
	RPCUnavailable      = "RPC_UNAVAILABLE"
	APIUnavailable      = "DEX_API_UNAVAILABLE"
	RateLimited         = "RATE_LIMITED"
	Unauthorized        = "UNAUTHORIZED"
	Forbidden           = "FORBIDDEN"
	NotAvailableHere    = "NOT_AVAILABLE_OVER_HTTP"
	GasSaleUnavailable  = "GAS_SALE_UNAVAILABLE"
	Internal            = "INTERNAL_ERROR"
)

// E is a user-facing error.
type E struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Hint    string         `json:"hint,omitempty"`
	Details map[string]any `json:"details,omitempty"`
	cause   error
}

func (e *E) Error() string {
	if e.Hint != "" {
		return e.Message + " " + e.Hint
	}
	return e.Message
}

// Unwrap returns the underlying cause (never shown to users).
func (e *E) Unwrap() error { return e.cause }

// New creates an error.
func New(code, msg string) *E { return &E{Code: code, Message: msg} }

// Newf creates an error with a formatted message.
func Newf(code, format string, a ...any) *E {
	return &E{Code: code, Message: fmt.Sprintf(format, a...)}
}

// WithHint adds a "what to do next" sentence.
func (e *E) WithHint(h string) *E { e.Hint = h; return e }

// With adds a detail for bots.
func (e *E) With(k string, v any) *E {
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	e.Details[k] = v
	return e
}

// Wrap keeps a technical cause for logs.
func (e *E) Wrap(cause error) *E { e.cause = cause; return e }

// As converts any error into an *E (unknown errors become INTERNAL_ERROR with their text).
func As(err error) *E {
	if err == nil {
		return nil
	}
	var e *E
	if errors.As(err, &e) {
		return e
	}
	return &E{Code: Internal, Message: err.Error(), cause: err}
}

// Is reports whether err carries the given code.
func Is(err error, code string) bool {
	var e *E
	return errors.As(err, &e) && e.Code == code
}

// HTTPStatus maps a code to the HTTP status of the local API.
func HTTPStatus(code string) int {
	switch code {
	case InvalidInput, UnknownMarket, AmbiguousMarket, UnknownToken, PasswordWeak, InvalidOrder, TriggerInvalid, LeverageTooHigh, TooLarge:
		return http.StatusBadRequest
	case Unauthorized, WrongPassword, PasswordRequired:
		return http.StatusUnauthorized
	case Forbidden, TransferNotAllowed, NotYours, NotAvailableHere, BackupLocked, TerminalRequired:
		return http.StatusForbidden
	case NotFound, UnknownCommand:
		return http.StatusNotFound
	case WalletLocked, PasswordExpired, WalletMissing, WalletTampered, AlreadyClosed, NonceConflict, TxPending:
		return http.StatusConflict
	case RateLimited, TooManyAttempts:
		return http.StatusTooManyRequests
	case RPCUnavailable, APIUnavailable, QuoteUnavailable, GasSaleUnavailable:
		return http.StatusServiceUnavailable
	case Internal:
		return http.StatusInternalServerError
	default:
		return http.StatusUnprocessableEntity // a valid request the market or the chain refused
	}
}
