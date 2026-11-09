// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Elyon Quest Campaign contract (ElyonTestnet)
/// @notice Emits the on-chain facts the Quest Engine indexer consumes:
///         Claimed / Minted / Delegated / Undelegated / Redelegated.
///         Native ELN send/receive quests are indexed from plain transfers.
contract CampaignQuests {
    address public owner;

    uint256 public claimAmount   = 5 ether;   // ELN per faucet claim
    uint256 public claimCooldown = 20 hours;  // < 24h so a daily claim always fits

    mapping(address => uint256) public lastClaim;
    mapping(address => uint256) public mintedTokenOf;   // 0 = not minted
    uint256 public nextTokenId = 1;

    struct Delegation { address validator; uint256 amount; uint64 since; bool active; }
    mapping(address => Delegation) public delegations;
    uint256 public totalDelegated;

    event Claimed(address indexed user, uint256 amount);
    event Minted(address indexed user, uint256 indexed tokenId);
    event Delegated(address indexed user, address indexed validator, uint256 amount);
    event Undelegated(address indexed user, address indexed validator, uint256 amount);
    event Redelegated(address indexed user, address indexed fromValidator, address indexed toValidator, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() payable { owner = msg.sender; }
    receive() external payable {}
    function fund() external payable {}

    function claim() external {
        require(block.timestamp >= lastClaim[msg.sender] + claimCooldown, "claim: cooldown");
        require(address(this).balance >= claimAmount, "claim: faucet empty");
        lastClaim[msg.sender] = block.timestamp;
        (bool ok, ) = msg.sender.call{value: claimAmount}("");
        require(ok, "claim: transfer failed");
        emit Claimed(msg.sender, claimAmount);
    }

    function canClaimAt(address user) external view returns (uint256) {
        return lastClaim[user] + claimCooldown;
    }

    function mint() external {
        require(mintedTokenOf[msg.sender] == 0, "mint: already minted");
        uint256 id = nextTokenId++;
        mintedTokenOf[msg.sender] = id;
        emit Minted(msg.sender, id);
    }

    function delegate(address validator) external payable {
        require(msg.value > 0, "delegate: zero stake");
        require(validator != address(0), "delegate: zero validator");
        Delegation storage d = delegations[msg.sender];
        require(!d.active, "delegate: already delegated");
        d.validator = validator;
        d.amount    = msg.value;
        d.since     = uint64(block.timestamp);
        d.active    = true;
        totalDelegated += msg.value;
        emit Delegated(msg.sender, validator, msg.value);
    }

    function redelegate(address newValidator) external {
        Delegation storage d = delegations[msg.sender];
        require(d.active, "redelegate: not delegated");
        require(newValidator != address(0) && newValidator != d.validator, "redelegate: same validator");
        address prev = d.validator;
        d.validator = newValidator;
        emit Redelegated(msg.sender, prev, newValidator, d.amount);
    }

    function undelegate() external {
        Delegation storage d = delegations[msg.sender];
        require(d.active, "undelegate: not delegated");
        uint256 amt = d.amount;
        address val = d.validator;
        d.active = false;
        d.amount = 0;
        totalDelegated -= amt;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "undelegate: refund failed");
        emit Undelegated(msg.sender, val, amt);
    }

    function setClaimParams(uint256 amount_, uint256 cooldown_) external onlyOwner {
        claimAmount = amount_;
        claimCooldown = cooldown_;
    }

    function withdraw(uint256 amount) external onlyOwner {
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
