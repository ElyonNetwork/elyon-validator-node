// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * UNPToken — Minimal ERC20 with built-in buy-with-UNP marketplace.
 *
 * v7.0 hardening (security audit fixes):
 *   - Optional MAX_SUPPLY cap (set in constructor; 0 = uncapped legacy mode)
 *     prevents owner from rugpulling holders by minting unlimited new supply
 *     after sales.
 *   - Mint reverts if it would exceed MAX_SUPPLY.
 *   - buyWithUNPMinOut(minOut) lets buyers protect against owner front-running
 *     setPrice() between submit and mine.
 *   - buyWithUNP() retains its zero-arg signature for backward compatibility,
 *     but with no slippage protection (caller chooses if they want safety).
 *   - Token owner cannot block transfers by reverting — `unchecked` math and
 *     forwarding via call{} matches the original semantics.
 */
contract UNPToken {
    string  public name;
    string  public symbol;
    uint8   public constant decimals = 18;
    uint256 public totalSupply;
    address public owner;
    /// price in wei of UNP per 1 whole token (1e18 base units)
    uint256 public priceWeiPerToken;

    /// v7.0: hard cap on totalSupply. 0 = no cap (preserves legacy unlimited
    /// behaviour for tokens that opt out). Once set in constructor, cannot
    /// change — guarantees holders are never diluted past this number.
    uint256 public immutable MAX_SUPPLY;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event PriceChanged(uint256 newPriceWeiPerToken);
    event Bought(address indexed buyer, uint256 unpPaidWei, uint256 tokensReceived);
    event Mint(address indexed to, uint256 amount, uint256 newTotalSupply);

    modifier onlyOwner() { require(msg.sender == owner, "UT: !owner"); _; }

    /// @param _maxSupplyTokens Hard supply cap (in whole tokens). Pass 0 for
    /// uncapped legacy behaviour. Once set, NEVER changes.
    constructor(
        string memory _name, string memory _symbol,
        uint256 _initialSupplyTokens, uint256 _priceWeiPerToken,
        uint256 _maxSupplyTokens
    ) {
        require(_priceWeiPerToken > 0, "UT: price=0");
        if (_maxSupplyTokens > 0) {
            require(_initialSupplyTokens <= _maxSupplyTokens, "UT: initial > cap");
        }
        name = _name; symbol = _symbol; owner = msg.sender;
        priceWeiPerToken = _priceWeiPerToken;
        MAX_SUPPLY = _maxSupplyTokens * 10**18;
        uint256 supply = _initialSupplyTokens * 10**18;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount); return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender]; require(a >= amount, "UT: !allow");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount); return true;
    }
    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "UT: zero to");
        uint256 b = balanceOf[from]; require(b >= amount, "UT: !bal");
        unchecked { balanceOf[from] = b - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function setPrice(uint256 _priceWeiPerToken) external onlyOwner {
        require(_priceWeiPerToken > 0, "UT: price=0");
        priceWeiPerToken = _priceWeiPerToken;
        emit PriceChanged(_priceWeiPerToken);
    }

    /// v7.0: respect MAX_SUPPLY cap when set
    function mint(address to, uint256 amountTokens) external onlyOwner {
        uint256 amt = amountTokens * 10**18;
        if (MAX_SUPPLY > 0) {
            require(totalSupply + amt <= MAX_SUPPLY, "UT: > MAX_SUPPLY");
        }
        totalSupply += amt;
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
        emit Mint(to, amt, totalSupply);
    }

    /// Backward-compatible no-slippage variant.
    function buyWithUNP() external payable {
        _buyWithUNP(0);
    }

    /// v7.0: slippage-protected buy. Reverts if buyer would receive fewer
    /// than `minTokensOut` (in 1e18 units). Use this to guard against owner
    /// front-running setPrice() between tx submission and inclusion.
    function buyWithUNPMinOut(uint256 minTokensOut) external payable {
        _buyWithUNP(minTokensOut);
    }

    function _buyWithUNP(uint256 minTokensOut) internal {
        require(priceWeiPerToken > 0, "UT: price=0");
        require(msg.value > 0, "UT: zero pay");
        uint256 tokens = (msg.value * 1e18) / priceWeiPerToken;
        require(tokens > 0, "UT: too small");
        require(tokens >= minTokensOut, "UT: slippage");
        require(balanceOf[owner] >= tokens, "UT: !owner bal");
        unchecked { balanceOf[owner] -= tokens; }
        balanceOf[msg.sender] += tokens;
        // Forward UNP to owner. If owner reverts (e.g., contract w/o receive),
        // the buyer still pays nothing — entire tx reverts. Same semantics as
        // before; documented here for clarity.
        (bool ok,) = owner.call{value: msg.value}("");
        require(ok, "UT: pay fail");
        emit Transfer(owner, msg.sender, tokens);
        emit Bought(msg.sender, msg.value, tokens);
    }
}
