// Package chain talks to the ElyonChain JSON-RPC endpoint: reads (single and batched), and building, signing,
// sending and confirming transactions. Signing happens in this process; only signed transactions leave it.
package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"

	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/version"
)

// MaxBatch is the largest JSON-RPC batch the Elyon node accepts.
const MaxBatch = 50

// Client is a connection to the Elyon RPC node.
type Client struct {
	RPC     *rpc.Client
	Eth     *ethclient.Client
	ChainID *big.Int
	URL     string

	sendMu sync.Mutex // one transaction at a time per process (nonce safety)
}

// Dial connects and verifies that the endpoint really is ElyonChain (chain id 55452773).
func Dial(ctx context.Context, url string) (*Client, error) {
	hc := &http.Client{Timeout: 30 * time.Second}
	rc, err := rpc.DialOptions(ctx, url, rpc.WithHTTPClient(hc), rpc.WithHeader("User-Agent", version.UserAgent()))
	if err != nil {
		return nil, errs.Newf(errs.RPCUnavailable, "Cannot reach the Elyon RPC at %s.", url).Wrap(err)
	}
	c := &Client{RPC: rc, Eth: ethclient.NewClient(rc), URL: url}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	id, err := c.Eth.ChainID(cctx)
	if err != nil {
		return nil, errs.Newf(errs.RPCUnavailable, "The Elyon RPC at %s did not answer.", url).WithHint("Check your internet connection, or set another rpc_url in config.json.").Wrap(err)
	}
	if id.Int64() != config.ChainID {
		return nil, errs.Newf(errs.ChainMismatch, "The RPC at %s is chain %s, not ElyonChain (%d). elyon-bot only works on ElyonChain.", url, id, config.ChainID)
	}
	c.ChainID = id
	return c, nil
}

// Call is one read-only contract call.
type Call struct {
	To   common.Address
	Data []byte
}

// CallResult is the outcome of one Call.
type CallResult struct {
	Data []byte
	Err  error
}

// CallContract performs one eth_call at the latest block.
func (c *Client) CallContract(ctx context.Context, to common.Address, data []byte) ([]byte, error) {
	out, err := c.Eth.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return nil, wrapRPC(err)
	}
	return out, nil
}

// CallFrom performs one eth_call as `from` (used to simulate transactions).
func (c *Client) CallFrom(ctx context.Context, from, to common.Address, data []byte, value *big.Int) ([]byte, error) {
	return c.Eth.CallContract(ctx, ethereum.CallMsg{From: from, To: &to, Data: data, Value: value}, nil)
}

// Read calls a view function and unpacks its outputs.
func (c *Client) Read(ctx context.Context, a abi.ABI, to common.Address, method string, args ...any) ([]any, error) {
	out, err := c.CallContract(ctx, to, Pack(a, method, args...))
	if err != nil {
		return nil, err
	}
	vals, err := a.Unpack(method, out)
	if err != nil {
		return nil, errs.Newf(errs.RPCUnavailable, "Unexpected answer from contract %s (%s).", to.Hex(), method).Wrap(err)
	}
	return vals, nil
}

// BatchCall runs many eth_calls in JSON-RPC batches of MaxBatch, a few batches in parallel.
func (c *Client) BatchCall(ctx context.Context, calls []Call) []CallResult {
	results := make([]CallResult, len(calls))
	type chunk struct{ start, end int }
	var chunks []chunk
	for i := 0; i < len(calls); i += MaxBatch {
		chunks = append(chunks, chunk{i, min(i+MaxBatch, len(calls))})
	}
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, ch := range chunks {
		wg.Add(1)
		sem <- struct{}{}
		go func(ch chunk) {
			defer wg.Done()
			defer func() { <-sem }()
			elems := make([]rpc.BatchElem, 0, ch.end-ch.start)
			outs := make([]hexutil.Bytes, ch.end-ch.start)
			for i := ch.start; i < ch.end; i++ {
				arg := map[string]any{"to": calls[i].To, "data": hexutil.Bytes(calls[i].Data)}
				elems = append(elems, rpc.BatchElem{Method: "eth_call", Args: []any{arg, "latest"}, Result: &outs[i-ch.start]})
			}
			var err error
			for attempt := 0; attempt < 3; attempt++ {
				if err = c.RPC.BatchCallContext(ctx, elems); err == nil {
					break
				}
				time.Sleep(time.Duration(300*(attempt+1)) * time.Millisecond)
			}
			for i := range elems {
				r := &results[ch.start+i]
				switch {
				case err != nil:
					r.Err = wrapRPC(err)
				case elems[i].Error != nil:
					r.Err = elems[i].Error
				default:
					r.Data = outs[i]
				}
			}
		}(ch)
	}
	wg.Wait()
	return results
}

// NativeBalances returns ELN balances for several addresses (batched).
func (c *Client) NativeBalance(ctx context.Context, a common.Address) (*big.Int, error) {
	b, err := c.Eth.BalanceAt(ctx, a, nil)
	if err != nil {
		return nil, wrapRPC(err)
	}
	return b, nil
}

// TokenBalance reads an ERC-20 balance.
func (c *Client) TokenBalance(ctx context.Context, token, owner common.Address) (*big.Int, error) {
	v, err := c.Read(ctx, ERC20ABI, token, "balanceOf", owner)
	if err != nil {
		return nil, err
	}
	return v[0].(*big.Int), nil
}

// Allowance reads an ERC-20 allowance.
func (c *Client) Allowance(ctx context.Context, token, owner, spender common.Address) (*big.Int, error) {
	v, err := c.Read(ctx, ERC20ABI, token, "allowance", owner, spender)
	if err != nil {
		return nil, err
	}
	return v[0].(*big.Int), nil
}

// HasCode reports whether an address is a contract.
func (c *Client) HasCode(ctx context.Context, a common.Address) (bool, error) {
	code, err := c.Eth.CodeAt(ctx, a, nil)
	if err != nil {
		return false, wrapRPC(err)
	}
	return len(code) > 0, nil
}

// BlockTime returns the latest block number and timestamp.
func (c *Client) Head(ctx context.Context) (uint64, time.Time, error) {
	h, err := c.Eth.HeaderByNumber(ctx, nil)
	if err != nil {
		return 0, time.Time{}, wrapRPC(err)
	}
	return h.Number.Uint64(), time.Unix(int64(h.Time), 0).UTC(), nil
}

func wrapRPC(err error) error {
	if err == nil {
		return nil
	}
	var e *errs.E
	if errors.As(err, &e) {
		return err
	}
	if _, ok := RevertReason(err); ok {
		return err // a revert is not an availability problem; callers map it
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "429") || strings.Contains(msg, "too many") {
		return errs.New(errs.RPCUnavailable, "The Elyon RPC is rate limiting requests. Please retry in a moment.").Wrap(err)
	}
	return errs.New(errs.RPCUnavailable, "ElyonChain is busy or unreachable right now. Please try again in a moment.").Wrap(err)
}

// UnpackBigs is a helper for single uint256 outputs.
func UnpackBig(a abi.ABI, method string, data []byte) (*big.Int, error) {
	vals, err := a.Unpack(method, data)
	if err != nil {
		return nil, err
	}
	v, ok := vals[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("unexpected %s output", method)
	}
	return v, nil
}
