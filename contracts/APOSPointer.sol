// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * APOSPointer
 * -----------
 * On-chain phone-book entry pointing at the canonical UNPRegistry for the
 * current chain. Operators on other servers read this to discover the active
 * registry — when admin upgrades, all dashboards auto-resync via this pointer.
 *
 * v7.0 hardening (security audit fix C-8):
 *   - setRegistry now uses a 24-hour timelock (propose → commit). A single
 *     admin-key signature can no longer instantly redirect chain economics.
 *   - applyPendingRegistry() can be called by ANYONE after the delay elapses
 *     (so admin doesn't need a second signature) but only during a 7-day
 *     grace window to prevent stale proposals lingering.
 *   - cancelPendingRegistry() lets admin abort a proposal mid-window.
 *   - 24h delay configurable by admin (1h..7d range) for emergency response.
 */
contract APOSPointer {
    address public admin;
    address public registry;
    uint256 public lastChangedAt;
    uint256 public version;

    // v7.0: timelock state
    address public pendingRegistry;
    uint256 public pendingActivatesAt;   // earliest valid commit time
    uint256 public pendingExpiresAt;     // commits after this revert (force re-propose)
    uint256 public timelockDelay = 24 hours;
    uint256 public constant MIN_DELAY = 1 hours;
    uint256 public constant MAX_DELAY = 7 days;
    uint256 public constant GRACE_WINDOW = 7 days;

    event AdminAssigned(address indexed admin);
    event RegistryProposed(address indexed pending, uint256 activatesAt, uint256 expiresAt);
    event RegistryProposalCancelled(address indexed pending);
    event RegistryChanged(address indexed previous, address indexed current, uint256 version);
    event TimelockDelayChanged(uint256 newDelay);

    modifier onlyAdmin() {
        require(msg.sender == admin, "POINTER: not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
        emit AdminAssigned(msg.sender);
    }

    /// v7.0: admin proposes a new registry; cannot take effect for 24h.
    /// v7.1.2: first-time bootstrap (registry == address(0)) applies
    /// immediately. The timelock's purpose is "no instant-rug after pointer
    /// is established" — an empty pointer has nothing to rug yet, and the
    /// initial set is by definition the only admin who deployed it.
    function proposeRegistry(address newRegistry) external onlyAdmin {
        require(newRegistry != address(0), "POINTER: zero addr");
        require(newRegistry != registry, "POINTER: same addr");
        uint256 size; assembly { size := extcodesize(newRegistry) }
        require(size > 0, "POINTER: target has no code");
        if (registry == address(0)) {
            // First-time set: skip timelock, commit immediately.
            address prev = registry;
            registry = newRegistry;
            lastChangedAt = block.timestamp;
            version += 1;
            emit RegistryChanged(prev, newRegistry, version);
            return;
        }
        // Subsequent changes: full 24h timelock.
        pendingRegistry = newRegistry;
        pendingActivatesAt = block.timestamp + timelockDelay;
        pendingExpiresAt = pendingActivatesAt + GRACE_WINDOW;
        emit RegistryProposed(newRegistry, pendingActivatesAt, pendingExpiresAt);
    }

    /// v7.0: admin can abort a pending proposal at any time.
    function cancelPendingRegistry() external onlyAdmin {
        require(pendingRegistry != address(0), "POINTER: no pending");
        emit RegistryProposalCancelled(pendingRegistry);
        pendingRegistry = address(0);
        pendingActivatesAt = 0;
        pendingExpiresAt = 0;
    }

    /// v7.0: anyone can commit the proposal after the delay (within grace
    /// window). Permissionless commit reduces admin-key handling needs while
    /// keeping the 24h notice intact.
    function applyPendingRegistry() external {
        require(pendingRegistry != address(0), "POINTER: no pending");
        require(block.timestamp >= pendingActivatesAt, "POINTER: too early");
        require(block.timestamp <= pendingExpiresAt, "POINTER: expired");
        // Re-check that target still has code (could have selfdestructed).
        address _pending = pendingRegistry;
        uint256 size; assembly { size := extcodesize(_pending) }
        require(size > 0, "POINTER: target has no code");
        address prev = registry;
        registry = pendingRegistry;
        lastChangedAt = block.timestamp;
        version += 1;
        pendingRegistry = address(0);
        pendingActivatesAt = 0;
        pendingExpiresAt = 0;
        emit RegistryChanged(prev, registry, version);
    }

    /// v7.0.8 (audit M4): legacy `setRegistry(...)` removed — it duplicated
    /// `applyPendingRegistry()` which is permissionless after the 24h delay.
    /// Callers should use proposeRegistry() + applyPendingRegistry() instead.

    function setTimelockDelay(uint256 newDelay) external onlyAdmin {
        require(newDelay >= MIN_DELAY && newDelay <= MAX_DELAY, "POINTER: out of range");
        timelockDelay = newDelay;
        emit TimelockDelayChanged(newDelay);
    }

    function getRegistry() external view returns (address current, uint256 v, uint256 changedAt) {
        return (registry, version, lastChangedAt);
    }
}
