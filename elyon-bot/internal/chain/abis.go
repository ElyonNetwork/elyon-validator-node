package chain

import (
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// The ABIs below list only the functions and events elyon-bot uses. They are copied from the verified sources
// in the DEX repository (packages/contracts-wrapper/contracts/markets, Uniswap V2 core/periphery, WELN9).

const quoteTuple = `{"name":"q","type":"tuple","components":[{"name":"marketId","type":"uint256"},{"name":"priceE18","type":"uint128"},{"name":"timestamp","type":"uint64"},{"name":"signature","type":"bytes"}]}`

const erc20JSON = `[
{"type":"function","name":"balanceOf","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"allowance","stateMutability":"view","inputs":[{"name":"o","type":"address"},{"name":"s","type":"address"}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"approve","stateMutability":"nonpayable","inputs":[{"name":"s","type":"address"},{"name":"v","type":"uint256"}],"outputs":[{"type":"bool"}]},
{"type":"function","name":"transfer","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"v","type":"uint256"}],"outputs":[{"type":"bool"}]},
{"type":"function","name":"decimals","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
{"type":"function","name":"symbol","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
{"type":"event","name":"Transfer","anonymous":false,"inputs":[{"name":"from","type":"address","indexed":true},{"name":"to","type":"address","indexed":true},{"name":"value","type":"uint256","indexed":false}]}
]`

const wethJSON = `[
{"type":"function","name":"deposit","stateMutability":"payable","inputs":[],"outputs":[]},
{"type":"function","name":"withdraw","stateMutability":"nonpayable","inputs":[{"name":"wad","type":"uint256"}],"outputs":[]}
]`

const routerJSON = `[
{"type":"function","name":"WETH","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"factory","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"swapExactTokensForTokens","stateMutability":"nonpayable","inputs":[{"name":"amountIn","type":"uint256"},{"name":"amountOutMin","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"type":"uint256[]"}]},
{"type":"function","name":"swapTokensForExactTokens","stateMutability":"nonpayable","inputs":[{"name":"amountOut","type":"uint256"},{"name":"amountInMax","type":"uint256"},{"name":"path","type":"address[]"},{"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],"outputs":[{"type":"uint256[]"}]}
]`

const pairJSON = `[
{"type":"function","name":"getReserves","stateMutability":"view","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]},
{"type":"function","name":"token0","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"token1","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}
]`

const factoryJSON = `[
{"type":"function","name":"getPair","stateMutability":"view","inputs":[{"name":"a","type":"address"},{"name":"b","type":"address"}],"outputs":[{"type":"address"}]}
]`

const perpJSON = `[
{"type":"function","name":"quote","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"paused","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
{"type":"function","name":"isFeeder","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"bool"}]},
{"type":"function","name":"maxQuoteAge","stateMutability":"view","inputs":[],"outputs":[{"type":"uint64"}]},
{"type":"function","name":"maxNotional","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"markets","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"name":"maxLeverage","type":"uint32"},{"name":"mmrPpm","type":"uint32"},{"name":"feePpm","type":"uint32"},{"name":"enabled","type":"bool"},{"name":"fundingIndexE18","type":"int256"},{"name":"symbol","type":"string"}]},
{"type":"function","name":"positions","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"name":"owner","type":"address"},{"name":"marketId","type":"uint32"},{"name":"isLong","type":"bool"},{"name":"open","type":"bool"},{"name":"openedAt","type":"uint64"},{"name":"margin","type":"uint128"},{"name":"notional","type":"uint128"},{"name":"entryPriceE18","type":"uint128"},{"name":"sizeE18","type":"uint128"},{"name":"entryFundingE18","type":"int256"}]},
{"type":"function","name":"positionFeePpm","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"type":"uint32"}]},
{"type":"function","name":"positionsOf","stateMutability":"view","inputs":[{"name":"t","type":"address"}],"outputs":[{"type":"uint256[]"}]},
{"type":"function","name":"liquidationPrice","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"type":"uint128"}]},
{"type":"function","name":"previewClose","stateMutability":"view","inputs":[{"name":"id","type":"uint256"},{"name":"priceE18","type":"uint128"}],"outputs":[{"name":"pnl","type":"int256"},{"name":"funding","type":"int256"},{"name":"fee","type":"uint256"},{"name":"payout","type":"uint256"},{"name":"liquidatable","type":"bool"},{"name":"equity","type":"int256"}]},
{"type":"function","name":"previewReduce","stateMutability":"view","inputs":[{"name":"id","type":"uint256"},{"name":"closeSizeE18","type":"uint128"},{"name":"priceE18","type":"uint128"}],"outputs":[{"name":"closedMargin","type":"uint256"},{"name":"pnl","type":"int256"},{"name":"funding","type":"int256"},{"name":"fee","type":"uint256"},{"name":"payout","type":"uint256"},{"name":"liquidatable","type":"bool"}]},
{"type":"function","name":"close","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},` + quoteTuple + `],"outputs":[]},
{"type":"function","name":"reduce","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},{"name":"closeSizeE18","type":"uint128"},` + quoteTuple + `],"outputs":[]},
{"type":"event","name":"PositionOpened","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"marketId","type":"uint256","indexed":true},{"name":"isLong","type":"bool","indexed":false},{"name":"margin","type":"uint256","indexed":false},{"name":"notional","type":"uint256","indexed":false},{"name":"leverage","type":"uint32","indexed":false},{"name":"entryPriceE18","type":"uint128","indexed":false},{"name":"fee","type":"uint256","indexed":false},{"name":"liquidationPriceE18","type":"uint128","indexed":false}]},
{"type":"event","name":"PositionReduced","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"marketId","type":"uint256","indexed":true},{"name":"exitPriceE18","type":"uint128","indexed":false},{"name":"closedSizeE18","type":"uint128","indexed":false},{"name":"closedMargin","type":"uint256","indexed":false},{"name":"pnl","type":"int256","indexed":false},{"name":"funding","type":"int256","indexed":false},{"name":"fee","type":"uint256","indexed":false},{"name":"payout","type":"uint256","indexed":false}]},
{"type":"event","name":"PositionClosed","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"marketId","type":"uint256","indexed":true},{"name":"exitPriceE18","type":"uint128","indexed":false},{"name":"pnl","type":"int256","indexed":false},{"name":"funding","type":"int256","indexed":false},{"name":"fee","type":"uint256","indexed":false},{"name":"payout","type":"uint256","indexed":false},{"name":"liquidated","type":"bool","indexed":false}]}
]`

const triggersJSON = `[
{"type":"function","name":"perp","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"quote","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"orders","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"name":"trader","type":"address"},{"name":"takeProfitE18","type":"uint128"},{"name":"stopLossE18","type":"uint128"}]},
{"type":"function","name":"positionsOf","stateMutability":"view","inputs":[{"name":"t","type":"address"}],"outputs":[{"type":"uint256[]"}]},
{"type":"function","name":"open","stateMutability":"nonpayable","inputs":[{"name":"marketId","type":"uint256"},{"name":"isLong","type":"bool"},{"name":"margin","type":"uint256"},{"name":"leverage","type":"uint32"},` + quoteTuple + `,{"name":"takeProfitE18","type":"uint128"},{"name":"stopLossE18","type":"uint128"}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"setTriggers","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},{"name":"takeProfitE18","type":"uint128"},{"name":"stopLossE18","type":"uint128"}],"outputs":[]},
{"type":"function","name":"close","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},` + quoteTuple + `],"outputs":[]},
{"type":"function","name":"reduce","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"},{"name":"closeSizeE18","type":"uint128"},` + quoteTuple + `],"outputs":[{"type":"uint256"}]},
{"type":"event","name":"TriggersSet","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"takeProfitE18","type":"uint128","indexed":false},{"name":"stopLossE18","type":"uint128","indexed":false}]},
{"type":"event","name":"Closed","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"payout","type":"uint256","indexed":false}]},
{"type":"event","name":"Reduced","anonymous":false,"inputs":[{"name":"positionId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"closedSizeE18","type":"uint128","indexed":false},{"name":"payout","type":"uint256","indexed":false}]}
]`

const limitJSON = `[
{"type":"function","name":"perp","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"paused","stateMutability":"view","inputs":[],"outputs":[{"type":"bool"}]},
{"type":"function","name":"minMargin","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"openOrderCount","stateMutability":"view","inputs":[{"name":"t","type":"address"}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"limitOrdersOf","stateMutability":"view","inputs":[{"name":"t","type":"address"}],"outputs":[{"type":"uint256[]"}]},
{"type":"function","name":"limitOrder","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"name":"o","type":"tuple","components":[{"name":"trader","type":"address"},{"name":"marketId","type":"uint32"},{"name":"leverage","type":"uint32"},{"name":"isLong","type":"bool"},{"name":"status","type":"uint8"},{"name":"margin","type":"uint128"},{"name":"maxCost","type":"uint128"},{"name":"limitPriceE18","type":"uint128"},{"name":"expiresAt","type":"uint64"},{"name":"placedAt","type":"uint64"},{"name":"takeProfitE18","type":"uint128"},{"name":"stopLossE18","type":"uint128"},{"name":"positionId","type":"uint256"}]}]},
{"type":"function","name":"previewLiquidation","stateMutability":"view","inputs":[{"name":"marketId","type":"uint256"},{"name":"isLong","type":"bool"},{"name":"margin","type":"uint256"},{"name":"leverage","type":"uint32"},{"name":"priceE18","type":"uint128"}],"outputs":[{"type":"uint128"}]},
{"type":"function","name":"placeLimit","stateMutability":"nonpayable","inputs":[{"name":"p","type":"tuple","components":[{"name":"marketId","type":"uint256"},{"name":"isLong","type":"bool"},{"name":"margin","type":"uint256"},{"name":"leverage","type":"uint32"},{"name":"limitPriceE18","type":"uint128"},{"name":"expiresAt","type":"uint64"},{"name":"takeProfitE18","type":"uint128"},{"name":"stopLossE18","type":"uint128"}]}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"cancelLimit","stateMutability":"nonpayable","inputs":[{"name":"id","type":"uint256"}],"outputs":[]},
{"type":"event","name":"LimitPlaced","anonymous":false,"inputs":[{"name":"orderId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true},{"name":"marketId","type":"uint256","indexed":true},{"name":"isLong","type":"bool","indexed":false},{"name":"margin","type":"uint256","indexed":false},{"name":"leverage","type":"uint32","indexed":false},{"name":"limitPriceE18","type":"uint128","indexed":false},{"name":"expiresAt","type":"uint64","indexed":false},{"name":"maxCost","type":"uint256","indexed":false}]},
{"type":"event","name":"LimitCancelled","anonymous":false,"inputs":[{"name":"orderId","type":"uint256","indexed":true},{"name":"trader","type":"address","indexed":true}]}
]`

const gasSaleJSON = `[
{"type":"function","name":"quote","stateMutability":"view","inputs":[{"name":"elnAmount","type":"uint256"}],"outputs":[{"type":"uint256"}]},
{"type":"function","name":"saleState","stateMutability":"view","inputs":[{"name":"buyer","type":"address"}],"outputs":[{"name":"price","type":"uint256"},{"name":"minEln","type":"uint256"},{"name":"maxEln","type":"uint256"},{"name":"dailyMaxEln","type":"uint256"},{"name":"boughtToday","type":"uint256"},{"name":"remainingToday","type":"uint256"},{"name":"inventory","type":"uint256"},{"name":"paused","type":"bool"},{"name":"treasury","type":"address"},{"name":"quoteToken","type":"address"}]},
{"type":"function","name":"buy","stateMutability":"nonpayable","inputs":[{"name":"elnAmount","type":"uint256"},{"name":"maxCost","type":"uint256"}],"outputs":[{"type":"uint256"}]},
{"type":"event","name":"Bought","anonymous":false,"inputs":[{"name":"buyer","type":"address","indexed":true},{"name":"elnAmount","type":"uint256","indexed":false},{"name":"cost","type":"uint256","indexed":false}]}
]`

func mustABI(s string) abi.ABI {
	a, err := abi.JSON(strings.NewReader(s))
	if err != nil {
		panic(err)
	}
	return a
}

// Parsed ABIs.
var (
	ERC20ABI    = mustABI(erc20JSON)
	WETHABI     = mustABI(wethJSON)
	RouterABI   = mustABI(routerJSON)
	PairABI     = mustABI(pairJSON)
	FactoryABI  = mustABI(factoryJSON)
	PerpABI     = mustABI(perpJSON)
	TriggersABI = mustABI(triggersJSON)
	LimitABI    = mustABI(limitJSON)
	GasSaleABI  = mustABI(gasSaleJSON)
)

// Pack encodes a call and panics on programming errors (wrong argument types are bugs, not user errors).
func Pack(a abi.ABI, method string, args ...any) []byte {
	b, err := a.Pack(method, args...)
	if err != nil {
		panic("abi pack " + method + ": " + err.Error())
	}
	return b
}
