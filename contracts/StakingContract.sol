// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title UNPChain Staking Contract
/// @notice Manages validator stakes for PoS consensus transition.
/// @dev    MIN_STAKE is set by admin at deploy time and can be updated later.
///        Anyone wishing to become a block-producing validator MUST stake
///        at least MIN_STAKE here. This is independent of the APOS
///        UNPRegistry (which gates fee-share for RPC node operators).
///
/// v7.0 hardening (security audit fixes):
///   - stake() resets unstakeRequestBlock if user re-stakes after requesting
///     unstake (fixes "withdraw all + stay active" exploit).
///   - O(1) validator removal via index mapping (fixes O(n) gas at scale).
///   - Reentrancy guard on withdraw().
contract StakingContract {
    address public admin;
    uint256 public MIN_STAKE;
    uint256 public constant UNSTAKE_DELAY = 100; // blocks

    struct Validator {
        uint256 stake;
        bool active;
        uint256 unstakeRequestBlock;
    }

    mapping(address => Validator) public validators;
    address[] public activeValidators;
    // v7.0: address -> (1+index) in activeValidators for O(1) removal. 0 = not present.
    mapping(address => uint256) private _activeIdxPlus1;

    // v7.0: reentrancy guard
    uint256 private _reentrancyStatus;

    event Staked(address indexed validator, uint256 amount);
    event UnstakeRequested(address indexed validator, uint256 requestBlock);
    event UnstakeCancelled(address indexed validator);   // v7.0
    event Withdrawn(address indexed validator, uint256 amount);
    event ValidatorActivated(address indexed validator);
    event ValidatorDeactivated(address indexed validator);
    event MinStakeChanged(uint256 oldMin, uint256 newMin);

    modifier nonReentrant() {
        require(_reentrancyStatus == 0, "Reentrancy");
        _reentrancyStatus = 1;
        _;
        _reentrancyStatus = 0;
    }

    /// @param _minStake Minimum stake (in wei) required for non-admin validators.
    constructor(uint256 _minStake) {
        require(_minStake > 0, "minStake=0");
        admin = msg.sender;
        MIN_STAKE = _minStake;
        Validator storage v = validators[msg.sender];
        v.active = true;
        activeValidators.push(msg.sender);
        _activeIdxPlus1[msg.sender] = activeValidators.length;
        emit ValidatorActivated(msg.sender);
    }

    function setMinStake(uint256 _newMin) external {
        require(msg.sender == admin, "Not admin");
        require(_newMin > 0, "minStake=0");
        emit MinStakeChanged(MIN_STAKE, _newMin);
        MIN_STAKE = _newMin;
    }

    /// @notice Stake to become a validator. Admin is exempt from the
    /// MIN_STAKE floor; everyone else must send >= MIN_STAKE on first stake.
    /// v7.0: Re-staking after unstakeRequest cancels the pending unstake so
    /// the new stake is properly locked again.
    function stake() external payable {
        if (msg.sender != admin) {
            require(msg.value >= MIN_STAKE, "Stake below minimum");
        }
        Validator storage v = validators[msg.sender];

        // v7.0: if user has a pending unstake request, re-staking cancels it.
        // Otherwise the user could exploit the timer: requestUnstake → wait
        // UNSTAKE_DELAY → stake() → withdraw() drains everything while still
        // listed in activeValidators[].
        if (v.unstakeRequestBlock != 0) {
            v.unstakeRequestBlock = 0;
            emit UnstakeCancelled(msg.sender);
        }

        v.stake += msg.value;

        if (!v.active && (msg.sender == admin || v.stake >= MIN_STAKE)) {
            v.active = true;
            activeValidators.push(msg.sender);
            _activeIdxPlus1[msg.sender] = activeValidators.length;
            emit ValidatorActivated(msg.sender);
        }

        emit Staked(msg.sender, msg.value);
    }

    function requestUnstake() external {
        Validator storage v = validators[msg.sender];
        require(v.active, "Not an active validator");
        require(v.unstakeRequestBlock == 0, "Already requested");

        v.unstakeRequestBlock = block.number;
        v.active = false;

        _removeValidator(msg.sender);

        emit UnstakeRequested(msg.sender, block.number);
        emit ValidatorDeactivated(msg.sender);
    }

    function withdraw() external nonReentrant {
        Validator storage v = validators[msg.sender];
        require(v.unstakeRequestBlock > 0, "No unstake request");
        require(block.number >= v.unstakeRequestBlock + UNSTAKE_DELAY, "Delay not met");

        uint256 amount = v.stake;
        v.stake = 0;
        v.unstakeRequestBlock = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    function getActiveValidators() external view returns (address[] memory) {
        return activeValidators;
    }

    function getActiveValidatorCount() external view returns (uint256) {
        return activeValidators.length;
    }

    function isActiveValidator(address addr) external view returns (bool) {
        return validators[addr].active;
    }

    function getStake(address addr) external view returns (uint256) {
        return validators[addr].stake;
    }

    /// v7.0: O(1) removal using the address->index mapping.
    function _removeValidator(address addr) internal {
        uint256 idxPlus1 = _activeIdxPlus1[addr];
        if (idxPlus1 == 0) return; // not in array
        uint256 idx = idxPlus1 - 1;
        uint256 last = activeValidators.length - 1;
        if (idx != last) {
            address moved = activeValidators[last];
            activeValidators[idx] = moved;
            _activeIdxPlus1[moved] = idx + 1;
        }
        activeValidators.pop();
        _activeIdxPlus1[addr] = 0;
    }
}
