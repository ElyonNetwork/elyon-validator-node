package spot

import (
	"bytes"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// PairInitCodeHash is the init code hash of the canonical Uniswap V2 pair on ElyonChain
// (deployments/55452773/contracts-evidence.json).
var PairInitCodeHash = common.HexToHash("0x1892ee6b3b8f653471529d0b06a772bdc5588bb0b15607cb427c8148f70004a9")

// PairFor computes the pool address of two tokens on a factory (CREATE2), the same address the router trades in.
// elyon-bot compares it with the pool the DEX API names, so a wrong pool address from the API is never used.
func PairFor(factory, a, b common.Address) common.Address {
	t0, t1 := a, b
	if bytes.Compare(a.Bytes(), b.Bytes()) > 0 {
		t0, t1 = b, a
	}
	salt := crypto.Keccak256(t0.Bytes(), t1.Bytes())
	return common.BytesToAddress(crypto.Keccak256([]byte{0xff}, factory.Bytes(), salt, PairInitCodeHash.Bytes())[12:])
}
