// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IELNTST { function mint(address to, uint256 amount) external; }

/// @title  Elyon Faucet — rate-limited ELNTST distributor
/// @notice Enforces the tokenomics spec directly on chain:
///           · one claim per 24 h per wallet
///           · role-based amounts (Validator | Delegator)
///           · hard daily supply cap that auto-resets every epoch
///         Admin can adjust amounts and the cap.  Off-chain anti-abuse
///         (IP rate limiting + CAPTCHA) is layered on top by the gateway.
contract Faucet {
    enum Role { Validator, Delegator }

    IELNTST public immutable token;
    address public admin;

    uint256 public validatorAmount = 100 ether;   // 100 ELNTST per claim
    uint256 public delegatorAmount =  25 ether;   //  25 ELNTST per claim
    uint256 public dailyCap        = 50_000 ether;

    uint256 public constant EPOCH_DURATION = 24 hours;

    /// last successful claim block-timestamp, keyed by recipient address.
    mapping(address => uint256) public lastClaimAt;
    /// total ELNTST distributed in a given epoch (block.timestamp / 24h).
    mapping(uint256 => uint256) public distributed;

    event Claimed(address indexed recipient, uint8 role, uint256 amount, uint256 indexed epoch);
    event AmountsUpdated(uint256 validatorAmount, uint256 delegatorAmount);
    event DailyCapUpdated(uint256 cap);
    event AdminTransferred(address indexed previous, address indexed current);

    constructor(address _token) {
        require(_token != address(0), "Faucet: zero token");
        token = IELNTST(_token);
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    modifier onlyAdmin() { require(msg.sender == admin, "Faucet: not admin"); _; }

    // ─── views ─────────────────────────────────────────────────────
    function currentEpoch()           public view returns (uint256) { return block.timestamp / EPOCH_DURATION; }
    function nextClaimAt(address u)   public view returns (uint256) { return lastClaimAt[u] == 0 ? 0 : lastClaimAt[u] + EPOCH_DURATION; }
    function remainingInEpoch()       public view returns (uint256) {
        uint256 d = distributed[currentEpoch()];
        return d >= dailyCap ? 0 : dailyCap - d;
    }
    function claimAmountFor(Role role) public view returns (uint256) {
        return role == Role.Validator ? validatorAmount : delegatorAmount;
    }
    function canClaim(address u, Role role) public view returns (bool ok, string memory reason) {
        if (block.timestamp < nextClaimAt(u)) return (false, "cooldown active");
        uint256 amount = claimAmountFor(role);
        if (distributed[currentEpoch()] + amount > dailyCap) return (false, "daily cap exhausted");
        return (true, "");
    }

    // ─── claim path — only the gateway admin signer can submit ─────
    //
    // Anti-frontrun: the gateway runs the CAPTCHA + IP rate limit then
    // signs a tx that calls this. The contract trusts the admin signer to
    // have done that work; on-chain rate limits + cap are the floor.
    function claim(address recipient, Role role) external onlyAdmin returns (uint256 amount) {
        require(recipient != address(0), "Faucet: zero recipient");
        require(block.timestamp >= nextClaimAt(recipient), "Faucet: cooldown active");

        amount = claimAmountFor(role);
        uint256 epoch = currentEpoch();
        require(distributed[epoch] + amount <= dailyCap, "Faucet: daily cap exhausted");

        distributed[epoch] += amount;
        lastClaimAt[recipient] = block.timestamp;
        token.mint(recipient, amount);
        emit Claimed(recipient, uint8(role), amount, epoch);
    }

    // ─── admin controls ────────────────────────────────────────────
    function setAmounts(uint256 _validator, uint256 _delegator) external onlyAdmin {
        require(_validator > 0 && _delegator > 0, "Faucet: zero amount");
        validatorAmount = _validator;
        delegatorAmount = _delegator;
        emit AmountsUpdated(_validator, _delegator);
    }
    function setDailyCap(uint256 _cap) external onlyAdmin {
        require(_cap > 0, "Faucet: zero cap");
        dailyCap = _cap;
        emit DailyCapUpdated(_cap);
    }
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Faucet: zero admin");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
