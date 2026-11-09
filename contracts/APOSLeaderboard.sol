// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  APOS Leaderboard
/// @notice Records per-node and per-owner monthly activity, scores them
///         against admin-tunable coefficients, and exposes a deterministic
///         leaderboard plus an optional reward pool that pays top-N entries
///         in the chain's native token (ELY/ELN).
///
///         A "month" is `block.timestamp / 2592000` (30-day epoch). The
///         registry stores raw counters; scores are computed at read time
///         so the admin can retune coefficients retroactively without
///         touching the historical data.
///
///         All writes are admin-gated. All reads are public.
contract APOSLeaderboard {
    address public admin;

    /* ─────────────────────── monthly counters ───────────────────────
     *  node ⇒ month ⇒ NodeMetrics
     *  owner ⇒ month ⇒ OwnerMetrics
     *  Anyone can read; only admin can write. */

    struct NodeMetrics {
        uint64  txCount;              // txs relayed via this node
        uint128 txVolumeWei;          // sum of gas fee volume in wei
        uint32  ownersStakedThrough;  // owners who staked through this node
        uint8   uptimePct;            // 0-100, set by admin (uptime bot)
    }
    struct OwnerMetrics {
        uint64  txCount;
        uint128 txVolumeWei;
        uint128 stakedTokens;         // total staked across packages this month
    }

    mapping(address => mapping(uint256 => NodeMetrics))  public nodeMonth;
    mapping(address => mapping(uint256 => OwnerMetrics)) public ownerMonth;

    /// totals across all months — useful for "lifetime" rankings.
    mapping(address => NodeMetrics)  public nodeTotal;
    mapping(address => OwnerMetrics) public ownerTotal;

    /// active nodes / owners that have ever been recorded.
    address[] public nodes;
    address[] public owners;
    mapping(address => bool) public isNode;
    mapping(address => bool) public isOwner;

    /* ─────────────────────── coefficients ─────────────────────────── */

    struct Coefficients {
        uint32 txCountWeight;       // per tx
        uint32 txVolumeWeight;      // per 1 ETH equivalent (×1e18)
        uint32 ownersStakedWeight;  // per owner staked through this node
        uint32 uptimeWeight;        // per percentage point
        uint32 stakePackageWeight;  // per staked token (1 ELY = 1e18 wei)
        uint32 stakePackageBase;    // flat per active staker
    }
    Coefficients public coefficients;

    /* ─────────────────────── reward pool ──────────────────────────── */

    struct RewardConfig {
        uint256 poolBalance;        // wei held in this contract for payouts
        uint16  topN;               // how many top entries pay out (e.g. 10)
        uint256 weiPerPoint;        // 1 point ⇒ N wei of reward token
    }
    RewardConfig public nodeRewards;
    RewardConfig public ownerRewards;

    /// month ⇒ entry ⇒ claimed flag. Once a month is claimed, no replay.
    mapping(uint256 => mapping(address => bool)) public nodeClaimed;
    mapping(uint256 => mapping(address => bool)) public ownerClaimed;

    /* ─────────────────────── events ───────────────────────────────── */

    event AdminTransferred(address indexed previous, address indexed current);
    event CoefficientsUpdated(Coefficients c);
    event NodeRewardsConfigured(uint16 topN, uint256 weiPerPoint, uint256 newBalance);
    event OwnerRewardsConfigured(uint16 topN, uint256 weiPerPoint, uint256 newBalance);
    event NodeTxRecorded(address indexed node, uint256 indexed month, uint64 newTxCount, uint128 newVolumeWei);
    event OwnerTxRecorded(address indexed owner, uint256 indexed month, uint64 newTxCount, uint128 newVolumeWei);
    event OwnerStakedThroughNode(address indexed node, address indexed owner, uint256 indexed month, uint128 stakedTokens);
    event NodeUptimeSet(address indexed node, uint256 indexed month, uint8 pct);
    event NodeRewardClaimed(address indexed node, uint256 indexed month, uint256 amountWei);
    event OwnerRewardClaimed(address indexed owner, uint256 indexed month, uint256 amountWei);
    event PoolFunded(string indexed kind, uint256 amountWei);

    /* ─────────────────────── constructor ─────────────────────────── */

    constructor() {
        admin = msg.sender;
        // Sensible defaults — admin can retune any time.
        coefficients = Coefficients({
            txCountWeight:      1,
            txVolumeWeight:     1,
            ownersStakedWeight: 10,
            uptimeWeight:       5,
            stakePackageWeight: 1,
            stakePackageBase:   3
        });
        emit AdminTransferred(address(0), msg.sender);
        emit CoefficientsUpdated(coefficients);
    }

    modifier onlyAdmin() { require(msg.sender == admin, "APOSLB: not admin"); _; }

    /* ─────────────────────── time helpers ─────────────────────────── */

    /// Returns the current 30-day month index.
    function currentMonth() public view returns (uint256) {
        return block.timestamp / 2592000;
    }

    /* ─────────────────────── admin: writes ────────────────────────── */

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "APOSLB: zero admin");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function setCoefficients(Coefficients calldata c) external onlyAdmin {
        coefficients = c;
        emit CoefficientsUpdated(c);
    }

    function setNodeRewards(uint16 topN, uint256 weiPerPoint) external onlyAdmin {
        nodeRewards.topN        = topN;
        nodeRewards.weiPerPoint = weiPerPoint;
        emit NodeRewardsConfigured(topN, weiPerPoint, nodeRewards.poolBalance);
    }

    function setOwnerRewards(uint16 topN, uint256 weiPerPoint) external onlyAdmin {
        ownerRewards.topN        = topN;
        ownerRewards.weiPerPoint = weiPerPoint;
        emit OwnerRewardsConfigured(topN, weiPerPoint, ownerRewards.poolBalance);
    }

    /// Admin tops up the node-reward pool with attached value.
    function fundNodePool() external payable onlyAdmin {
        require(msg.value > 0, "APOSLB: zero value");
        nodeRewards.poolBalance += msg.value;
        emit PoolFunded("node", msg.value);
        emit NodeRewardsConfigured(nodeRewards.topN, nodeRewards.weiPerPoint, nodeRewards.poolBalance);
    }
    function fundOwnerPool() external payable onlyAdmin {
        require(msg.value > 0, "APOSLB: zero value");
        ownerRewards.poolBalance += msg.value;
        emit PoolFunded("owner", msg.value);
        emit OwnerRewardsConfigured(ownerRewards.topN, ownerRewards.weiPerPoint, ownerRewards.poolBalance);
    }

    function _trackNode(address node) internal {
        if (!isNode[node]) { isNode[node] = true; nodes.push(node); }
    }
    function _trackOwner(address owner_) internal {
        if (!isOwner[owner_]) { isOwner[owner_] = true; owners.push(owner_); }
    }

    /// Admin records a relayed tx for a given node (called by the chain's
    /// in-block fee distributor or the L2 hook). `volume` is gas fee in wei.
    function recordNodeTx(address node, uint128 volume) external onlyAdmin {
        uint256 m = currentMonth();
        _trackNode(node);
        NodeMetrics storage nm = nodeMonth[node][m];
        nm.txCount += 1;
        nm.txVolumeWei += volume;
        NodeMetrics storage nt = nodeTotal[node];
        nt.txCount += 1;
        nt.txVolumeWei += volume;
        emit NodeTxRecorded(node, m, nm.txCount, nm.txVolumeWei);
    }

    /// Admin records an owner-side tx (contract calls, token transfers that
    /// touched a registered owner). Same volume semantics.
    function recordOwnerTx(address owner_, uint128 volume) external onlyAdmin {
        uint256 m = currentMonth();
        _trackOwner(owner_);
        OwnerMetrics storage om = ownerMonth[owner_][m];
        om.txCount += 1;
        om.txVolumeWei += volume;
        OwnerMetrics storage ot = ownerTotal[owner_];
        ot.txCount += 1;
        ot.txVolumeWei += volume;
        emit OwnerTxRecorded(owner_, m, om.txCount, om.txVolumeWei);
    }

    /// Admin records that `owner` staked through `node` this month with
    /// `stakedTokens` total committed. Same owner+node twice in one month
    /// counts as ONE attribution; subsequent calls just update stakedTokens.
    function recordOwnerStakeThroughNode(
        address node,
        address owner_,
        uint128 stakedTokens
    ) external onlyAdmin {
        uint256 m = currentMonth();
        _trackNode(node);
        _trackOwner(owner_);
        bytes32 key = keccak256(abi.encodePacked(node, owner_, m));
        if (!_stakedThisMonth[key]) {
            _stakedThisMonth[key] = true;
            nodeMonth[node][m].ownersStakedThrough += 1;
            nodeTotal[node].ownersStakedThrough    += 1;
        }
        ownerMonth[owner_][m].stakedTokens = stakedTokens;
        ownerTotal[owner_].stakedTokens    = stakedTokens;
        emit OwnerStakedThroughNode(node, owner_, m, stakedTokens);
    }
    mapping(bytes32 => bool) private _stakedThisMonth;

    /// Admin (uptime bot) records the node's uptime percentage for a month.
    function setNodeUptime(address node, uint256 month, uint8 pct) external onlyAdmin {
        require(pct <= 100, "APOSLB: pct > 100");
        _trackNode(node);
        nodeMonth[node][month].uptimePct = pct;
        emit NodeUptimeSet(node, month, pct);
    }

    /* ─────────────────────── score functions ──────────────────────── */

    /// Score = txCount*w1 + (txVolume/1e18)*w2 + ownersStaked*w3 +
    ///         uptimePct*w4 + (stakedTokens/1e18)*w5 + base
    function scoreNode(address node, uint256 month) public view returns (uint256) {
        NodeMetrics memory nm = nodeMonth[node][month];
        Coefficients memory c = coefficients;
        uint256 vol = uint256(nm.txVolumeWei) / 1e18;
        return uint256(nm.txCount)             * c.txCountWeight
             + vol                             * c.txVolumeWeight
             + uint256(nm.ownersStakedThrough) * c.ownersStakedWeight
             + uint256(nm.uptimePct)           * c.uptimeWeight;
    }
    function scoreOwner(address owner_, uint256 month) public view returns (uint256) {
        OwnerMetrics memory om = ownerMonth[owner_][month];
        Coefficients memory c = coefficients;
        uint256 vol = uint256(om.txVolumeWei) / 1e18;
        uint256 stk = uint256(om.stakedTokens) / 1e18;
        return uint256(om.txCount) * c.txCountWeight
             + vol                 * c.txVolumeWeight
             + stk                 * c.stakePackageWeight
             + (om.txCount > 0 || om.stakedTokens > 0 ? c.stakePackageBase : 0);
    }

    /* ─────────────────────── leaderboards ─────────────────────────── */

    function nodeCount()  external view returns (uint256) { return nodes.length; }
    function ownerCount() external view returns (uint256) { return owners.length; }

    /// Returns a slice of nodes + their scores for the given month. Caller
    /// sorts off-chain. Up to `limit` (256) records per call; use `offset`
    /// to page if there are more.
    function nodeSlice(uint256 month, uint256 offset, uint256 limit)
        external view returns (address[] memory addrs, uint256[] memory scores, NodeMetrics[] memory metrics)
    {
        uint256 n = nodes.length;
        if (offset >= n) return (new address[](0), new uint256[](0), new NodeMetrics[](0));
        uint256 end = offset + limit; if (end > n) end = n;
        uint256 len = end - offset;
        addrs   = new address[](len);
        scores  = new uint256[](len);
        metrics = new NodeMetrics[](len);
        for (uint256 i = 0; i < len; i++) {
            address a = nodes[offset + i];
            addrs[i]   = a;
            scores[i]  = scoreNode(a, month);
            metrics[i] = nodeMonth[a][month];
        }
    }

    function ownerSlice(uint256 month, uint256 offset, uint256 limit)
        external view returns (address[] memory addrs, uint256[] memory scores, OwnerMetrics[] memory metrics)
    {
        uint256 n = owners.length;
        if (offset >= n) return (new address[](0), new uint256[](0), new OwnerMetrics[](0));
        uint256 end = offset + limit; if (end > n) end = n;
        uint256 len = end - offset;
        addrs   = new address[](len);
        scores  = new uint256[](len);
        metrics = new OwnerMetrics[](len);
        for (uint256 i = 0; i < len; i++) {
            address a = owners[offset + i];
            addrs[i]   = a;
            scores[i]  = scoreOwner(a, month);
            metrics[i] = ownerMonth[a][month];
        }
    }

    /* ─────────────────────── claims ──────────────────────────────── */

    /// Pays out node rewards for a finalised month. Anyone may submit the
    /// sorted top list (computed off-chain from `nodeSlice`); the contract
    /// only verifies that (a) addresses are unique, (b) each is in fact in
    /// the top-N by re-scoring, and (c) the month has fully elapsed.
    /// Pays `score * weiPerPoint` from the pool, capped by poolBalance.
    function claimNodeReward(uint256 month, address[] calldata sortedTop)
        external returns (uint256 totalPaid)
    {
        require(month < currentMonth(), "APOSLB: month not finalised");
        uint256 n = sortedTop.length;
        require(n <= nodeRewards.topN && n > 0, "APOSLB: bad top size");
        // Score floor — anyone outside top-N has score ≤ caller's last
        uint256 floorScore = scoreNode(sortedTop[n - 1], month);
        for (uint256 i = 0; i < n; i++) {
            address a = sortedTop[i];
            require(!nodeClaimed[month][a], "APOSLB: already claimed");
            uint256 s = scoreNode(a, month);
            require(s >= floorScore, "APOSLB: not sorted");
            nodeClaimed[month][a] = true;
            uint256 reward = s * nodeRewards.weiPerPoint;
            if (reward > nodeRewards.poolBalance) reward = nodeRewards.poolBalance;
            nodeRewards.poolBalance -= reward;
            totalPaid += reward;
            (bool ok, ) = a.call{value: reward}("");
            require(ok, "APOSLB: pay failed");
            emit NodeRewardClaimed(a, month, reward);
        }
    }

    function claimOwnerReward(uint256 month, address[] calldata sortedTop)
        external returns (uint256 totalPaid)
    {
        require(month < currentMonth(), "APOSLB: month not finalised");
        uint256 n = sortedTop.length;
        require(n <= ownerRewards.topN && n > 0, "APOSLB: bad top size");
        uint256 floorScore = scoreOwner(sortedTop[n - 1], month);
        for (uint256 i = 0; i < n; i++) {
            address a = sortedTop[i];
            require(!ownerClaimed[month][a], "APOSLB: already claimed");
            uint256 s = scoreOwner(a, month);
            require(s >= floorScore, "APOSLB: not sorted");
            ownerClaimed[month][a] = true;
            uint256 reward = s * ownerRewards.weiPerPoint;
            if (reward > ownerRewards.poolBalance) reward = ownerRewards.poolBalance;
            ownerRewards.poolBalance -= reward;
            totalPaid += reward;
            (bool ok, ) = a.call{value: reward}("");
            require(ok, "APOSLB: pay failed");
            emit OwnerRewardClaimed(a, month, reward);
        }
    }

    receive() external payable { /* fund-pool helper for raw transfers */ }
}
