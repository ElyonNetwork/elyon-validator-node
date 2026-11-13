package app

import (
	"context"
	"math/big"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/elyon-chain/elyon-bot/internal/amount"
	"github.com/elyon-chain/elyon-bot/internal/chain"
	"github.com/elyon-chain/elyon-bot/internal/config"
	"github.com/elyon-chain/elyon-bot/internal/errs"
	"github.com/elyon-chain/elyon-bot/internal/registry"
	"github.com/elyon-chain/elyon-bot/internal/spot"
)

// Asset is a coin or token the wallet can hold.
type Asset struct {
	Symbol   string         `json:"symbol"`
	Name     string         `json:"name"`
	Address  common.Address `json:"address"` // zero for native ELN
	Decimals int            `json:"decimals"`
	Kind     string         `json:"kind"` // native, wusdt, weln, core, extended, previous-generation, other
	Base     string         `json:"base,omitempty"`
}

// Native reports whether the asset is ELN itself.
func (as Asset) Native() bool { return as.Kind == "native" }

// TokenKey is the ledger key ("native" or the lower-case address).
func (as Asset) TokenKey() string {
	if as.Native() {
		return "native"
	}
	return strings.ToLower(as.Address.Hex())
}

// knownAssets lists ELN, wUSDT, WELN, every Elyon wrapped token (API, else the built-in list) and the previous
// generation of reviewed tokens, de-duplicated by address.
func (x *Ctx) knownAssets(ctx context.Context) []Asset {
	k := x.Cfg.Contracts
	out := []Asset{
		{Symbol: "ELN", Name: "Elyon (native coin, pays gas)", Decimals: 18, Kind: "native"},
		{Symbol: "wUSDT", Name: "Tether USD (Elyon)", Address: config.Addr(k.WUSDT), Decimals: 6, Kind: "wusdt", Base: "USDT"},
		{Symbol: "WELN", Name: "Wrapped ELN", Address: config.Addr(k.WELN), Decimals: 18, Kind: "weln"},
	}
	seen := map[common.Address]bool{config.Addr(k.WUSDT): true, config.Addr(k.WELN): true}
	add := func(as Asset) {
		if as.Address == (common.Address{}) || seen[as.Address] {
			return
		}
		seen[as.Address] = true
		out = append(out, as)
	}
	if wa, err := x.DEX().WrappedAssets(ctx); err == nil && len(wa.Assets)+len(wa.Extended) > 0 {
		for _, a := range wa.Assets {
			add(Asset{Symbol: a.Symbol, Name: a.UnderlyingName, Address: common.HexToAddress(a.Token), Decimals: a.Decimals, Kind: "core", Base: a.Base})
		}
		for _, a := range wa.Extended {
			add(Asset{Symbol: a.Symbol, Name: a.UnderlyingName, Address: common.HexToAddress(a.Token), Decimals: a.Decimals, Kind: "extended", Base: a.Base})
		}
	} else {
		for _, t := range registry.All() {
			add(Asset{Symbol: t.Symbol, Name: t.Name, Address: t.Addr(), Decimals: t.Decimals, Kind: t.Tier, Base: t.Base})
		}
	}
	if tl, err := x.DEX().TokenList(ctx); err == nil {
		for _, t := range tl {
			if t.ChainID != 0 && t.ChainID != config.ChainID {
				continue
			}
			add(Asset{Symbol: t.Symbol + " (old)", Name: t.Name + " — previous generation, no longer traded", Address: common.HexToAddress(t.Address), Decimals: t.Decimals, Kind: "previous-generation"})
		}
	}
	return out
}

// resolveAsset finds the coin or token a user means for a transfer: ELN, wUSDT, WELN, a market ticker or an
// address (any ERC-20 on ElyonChain; its decimals and symbol are read on-chain).
func (x *Ctx) resolveAsset(ctx context.Context, in string) (Asset, error) {
	s := strings.TrimSpace(in)
	k := x.Cfg.Contracts
	switch strings.ToUpper(s) {
	case "":
		return Asset{}, errs.New(errs.InvalidInput, "Name the coin or token, for example ELN, wUSDT or wBTC.")
	case "ELN":
		return Asset{Symbol: "ELN", Name: "Elyon", Decimals: 18, Kind: "native"}, nil
	case "WELN":
		return Asset{Symbol: "WELN", Name: "Wrapped ELN", Address: config.Addr(k.WELN), Decimals: 18, Kind: "weln"}, nil
	case "WUSDT", "USDT":
		return Asset{Symbol: "wUSDT", Name: "Tether USD (Elyon)", Address: config.Addr(k.WUSDT), Decimals: 6, Kind: "wusdt", Base: "USDT"}, nil
	}
	if common.IsHexAddress(s) {
		a, err := ParseAddress(s)
		if err != nil {
			return Asset{}, err
		}
		for _, as := range x.knownAssets(ctx) {
			if as.Address == a {
				return as, nil
			}
		}
		c, err := x.Chain(ctx)
		if err != nil {
			return Asset{}, err
		}
		dec, err := c.Read(ctx, chain.ERC20ABI, a, "decimals")
		if err != nil {
			return Asset{}, errs.Newf(errs.UnknownToken, "%s is not an ERC-20 token on ElyonChain.", a.Hex())
		}
		sym := a.Hex()[:8]
		if v, err := c.Read(ctx, chain.ERC20ABI, a, "symbol"); err == nil {
			sym, _ = v[0].(string)
		}
		return Asset{Symbol: sym, Name: sym, Address: a, Decimals: int(dec[0].(uint8)), Kind: "other"}, nil
	}
	ms, err := x.spotMarkets(ctx)
	if err == nil {
		if m, err := spot.Resolve(s, ms); err == nil {
			return Asset{Symbol: m.Display, Name: m.Name, Address: m.Token, Decimals: m.Decimals, Kind: m.Tier, Base: m.Base}, nil
		} else if errs.Is(err, errs.AmbiguousMarket) {
			return Asset{}, err
		}
	}
	if t, ok := registry.ByBase(strings.TrimPrefix(strings.TrimPrefix(s, "w"), "W")); ok && strings.EqualFold("w"+t.Base, s) {
		return Asset{Symbol: t.Symbol, Name: t.Name, Address: t.Addr(), Decimals: t.Decimals, Kind: t.Tier, Base: t.Base}, nil
	}
	return Asset{}, errs.Newf(errs.UnknownToken, "Unknown coin or token %q.", s).WithHint("Use ELN, wUSDT, WELN, a ticker such as wBTC, or the token address.")
}

// Holding is one balance line.
type Holding struct {
	Asset
	Balance    string  `json:"balance"`
	Raw        string  `json:"balance_raw"`
	ValueWUSDT *string `json:"value_wusdt,omitempty"`
}

// balances reads ELN and every known token balance of owner (batched JSON-RPC, 50 per request).
func (x *Ctx) balances(ctx context.Context, owner common.Address, assets []Asset) ([]Holding, error) {
	c, err := x.Chain(ctx)
	if err != nil {
		return nil, err
	}
	var calls []chain.Call
	var idx []int
	out := make([]Holding, len(assets))
	for i, as := range assets {
		out[i] = Holding{Asset: as, Balance: "0", Raw: "0"}
		if as.Native() {
			continue
		}
		calls = append(calls, chain.Call{To: as.Address, Data: chain.Pack(chain.ERC20ABI, "balanceOf", owner)})
		idx = append(idx, i)
	}
	nat, err := c.NativeBalance(ctx, owner)
	if err != nil {
		return nil, err
	}
	for i, as := range assets {
		if as.Native() {
			out[i].Raw, out[i].Balance = nat.String(), amount.Format(nat, 18)
		}
	}
	failed := 0
	for j, r := range c.BatchCall(ctx, calls) {
		i := idx[j]
		if r.Err != nil || len(r.Data) < 32 {
			failed++
			continue
		}
		v := new(big.Int).SetBytes(r.Data[:32])
		out[i].Raw, out[i].Balance = v.String(), amount.Format(v, assets[i].Decimals)
	}
	if failed > len(calls)/2 && len(calls) > 0 {
		return nil, errs.New(errs.RPCUnavailable, "Could not read most token balances from the Elyon RPC.").WithHint("Retry in a moment.")
	}
	return out, nil
}

// priceMap returns pool prices (wUSDT per token) by token address.
func (x *Ctx) priceMap(ctx context.Context) map[common.Address]float64 {
	out := map[common.Address]float64{}
	ms, err := x.spotMarkets(ctx)
	if err != nil {
		return out
	}
	for _, m := range ms {
		if m.Price != nil && *m.Price > 0 {
			out[m.Token] = *m.Price
		} else if m.Reference != nil && *m.Reference > 0 {
			out[m.Token] = *m.Reference
		}
	}
	return out
}

func valueOf(h Holding, prices map[common.Address]float64, wusdt common.Address) *string {
	raw, ok := new(big.Int).SetString(h.Raw, 10)
	if !ok || raw.Sign() == 0 {
		return nil
	}
	if h.Address == wusdt {
		s := amount.FormatMax(raw, 6, 2)
		return &s
	}
	p, ok := prices[h.Address]
	if !ok {
		return nil
	}
	v := amount.ToFloat(raw, h.Decimals) * p
	s := strings.TrimRight(strings.TrimRight(big.NewFloat(v).Text('f', 2), "0"), ".")
	if s == "" {
		s = "0"
	}
	return &s
}

func sortHoldings(hs []Holding) {
	rank := map[string]int{"native": 0, "wusdt": 1, "weln": 2}
	sort.SliceStable(hs, func(i, j int) bool {
		ri, iok := rank[hs[i].Kind]
		rj, jok := rank[hs[j].Kind]
		if iok || jok {
			if !iok {
				ri = 9
			}
			if !jok {
				rj = 9
			}
			return ri < rj
		}
		vi, vj := 0.0, 0.0
		if hs[i].ValueWUSDT != nil {
			f, _ := new(big.Float).SetString(*hs[i].ValueWUSDT)
			vi, _ = f.Float64()
		}
		if hs[j].ValueWUSDT != nil {
			f, _ := new(big.Float).SetString(*hs[j].ValueWUSDT)
			vj, _ = f.Float64()
		}
		if vi != vj {
			return vi > vj
		}
		return hs[i].Symbol < hs[j].Symbol
	})
}
