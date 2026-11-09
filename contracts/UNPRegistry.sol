// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * UNPRegistry — APOS (Authorized Proof of Stake) core, v9 model.
 *
 * REDESIGN (2026-06, economics rework): ONE POOL, DAILY PROFIT, DELEGATOR
 * RATE with GRANDFATHERED POSITIONS.
 *
 * Roles & rules
 * ─────────────
 * ONE POOL PER VALIDATOR:
 *   The tier curve AND the BELOW_MIN rule read `selfStake + delegatedTotal`.
 *   There is no stake-vs-pool split any more — delegator deposits raise the
 *   tier directly and validator-custodial pool moves (stakeFromPool /
 *   withdrawPool) are GONE.
 *
 * VALIDATOR
 *   - Must run their own node. Applies by staking THROUGH an admin package
 *     (applyAsValidator(pubKey, packageId)) → admin approves and issues a
 *     unique public APOS code.
 *   - ONE PACKAGE AT A TIME: validatorStakeInPackage tops up the SAME
 *     selected package only (re-locks the same term). selectPackage(newPkg)
 *     is only allowed once the current term has ended (stakeUnlockTs) —
 *     there is no early-withdraw bypass.
 *   - DAILY PROFIT: package APR accrues continuously on selfStake
 *     (selfStake × pkg.aprBps × elapsed / (10000 × 365d)) while ACTIVE.
 *     claimValidatorProfit() pays the accrued profit any time from the
 *     reward pool (admin-pool top-up fallback). No more at-unlock APR lump.
 *   - withdrawValidatorStake: principal only after stakeUnlockTs (or when
 *     REJECTED/SUSPENDED); pays out any accrued profit too.
 *   - TIER-2 PACKAGES (two-tier marketing model): the validator PUBLISHES
 *     its own delegation packages (addValidatorPackage: name, lock term,
 *     min deposit, ANNUAL rate ≤ tier-1 package APR, early-exit penalty
 *     ≤ 20%). Delegators join a specific package; its terms are snapshotted
 *     into the position. The legacy delegatorRateBps mapping stays for
 *     back-compat but is dormant (positions now snapshot VPackage rates).
 *   - PROFILE: setProfile(json ≤1000 chars) — the public validator page
 *     renders {company, contact, address, website, about}.
 *     validatorOffer remains as free display text.
 *   - Earns gasShareBps of tx fees by the admin tier curve, driven by the
 *     ONE POOL (selfStake + delegatedTotal).
 *
 * DELEGATOR
 *   - Deposits create POSITIONS (multiple per delegator allowed) INTO a
 *     chosen validator package — delegate(op, vpkgIdx) /
 *     delegateByCode(code, vpkgIdx). Each position snapshots the package's
 *     rate, lockSeconds and penaltyBps — GRANDFATHERED: later package
 *     changes never touch existing positions.
 *   - SELF-WITHDRAW: withdrawPosition(op, posIdx, amount) pays principal +
 *     accrued profit (amount × rateBps × elapsed / (10000 × 365d)) from the
 *     reward pool. If withdrawn before since + lockSeconds, the position's
 *     penaltyBps of the withdrawn principal is deducted and credited to the
 *     validator's accumulatedFees (replaces the old global 30d/1% rule).
 *   - The validator may also return principal (+ accrued profit, no
 *     penalty) via releaseToDelegator, and may still hand out manual gifts
 *     (distributeToDelegator) and label its delegators.
 *
 * ADMIN
 *   - Approves/rejects/suspends validators and issues their codes.
 *   - Creates the staking packages (the ONLY creator of packages).
 *   - Owns the tier curve (pool volume → APR bps + gasShareBps).
 *   - Owns the residual fee pool.
 *
 * STORAGE-LAYOUT INVARIANT (consensus fee hook reads slots directly):
 *   slot  6 validators mapping · slot 17 adminAccumulatedFees ·
 *   slot 19 validatorOffer · Validator offsets status=+2 gasShareBps=+8
 *   accumulatedFees=+10. New Validator fields are APPENDED (lastAccrual=+12,
 *   accruedProfit=+13); new top-level state uses slots ≥20. Slot 11 keeps a
 *   retired placeholder where delegationIndexPlus1 used to live. The
 *   one-package-per-delegator mappings are APPENDED at slots 25-27.
 *
 * Retained security patterns: reentrancy guard, global pause, 24h-timelocked
 * admin transfer, non-custodial principals.
 */

contract UNPRegistry {
    // ───────── Enums ─────────
    // APPEND-ONLY: BELOW_MIN (=5) was appended so the existing numeric values
    // (and the consensus fee-hook's `status == 2` check) stay unchanged.
    // BELOW_MIN = an approved validator whose POOL (selfStake+delegatedTotal)
    // dropped under minValidatorStake; it earns nothing until the pool is
    // refilled, at which point _applyTier auto-restores it to ACTIVE.
    enum ValidatorStatus { NONE, PENDING, ACTIVE, REJECTED, SUSPENDED, BELOW_MIN }

    // ───────── Structs ─────────
    struct Validator {
        address operator;
        bytes   publicKey;
        ValidatorStatus status;
        string  code;             // unique public APOS code (issued at approval)
        uint256 selfStake;        // validator's own package-locked stake
        uint256 delegatedTotal;   // sum of all open delegator positions
        uint256 selectedPackageId;// admin package this validator staked into (0 = none)
        uint256 stakeUnlockTs;    // unlock time for the package-locked selfStake
        uint256 gasShareBps;      // current gas-fee share (tier-derived)
        uint256 aprBps;           // current APR (tier-derived, informational)
        uint256 accumulatedFees;  // earned gas-fee share + delegator early penalties
        uint256 registeredAt;
        // ── v9 APPENDED fields (offsets +12 / +13) ──
        uint256 lastAccrual;      // last daily-profit accrual timestamp
        uint256 accruedProfit;    // claimable package-APR profit (claimValidatorProfit)
    }

    // A delegator deposit. Each deposit is a NEW position into one of the
    // validator's published sub-packages (VPackage). The terms — rate, lock
    // and early-exit penalty — are SNAPSHOTTED at deposit time and
    // grandfathered forever (later VPackage edits never touch them).
    struct Position {
        address delegator;
        uint256 amount;           // remaining principal (non-custodial)
        uint256 rateBps;          // ANNUAL APR snapshot at deposit (from the VPackage)
        uint256 since;            // deposit timestamp (profit + penalty clock)
        uint256 withdrawn;        // lifetime principal withdrawn from this position
        string  label;            // optional per-position tag (display)
        // ── two-tier marketing model: VPackage terms snapshot (APPENDED) ──
        uint256 vpkgId;           // id of the validator package joined (1-based)
        uint256 lockSeconds;      // lock term snapshot — early exit before since+lockSeconds pays penaltyBps
        uint256 penaltyBps;       // early-exit penalty snapshot (bps of withdrawn principal)
    }

    // TIER-2 — a VALIDATOR-published delegation package ("sub-package").
    // The admin approves validators at tier-1 economics (admin packages);
    // each validator then markets its own packages to delegators, capped at
    // its tier-1 APR. Stored per validator; positions snapshot the terms.
    struct VPackage {
        uint256 id;               // per-validator id (1-based, = array index + 1)
        string  name;
        uint256 lockSeconds;      // delegator lock term
        uint256 minAmountWei;     // min deposit per position (no maximum)
        uint256 rateBps;          // ANNUAL APR paid to delegators (≤ tier-1 package APR)
        uint256 penaltyBps;       // early-exit penalty (≤ 2000 = 20%)
        bool    active;
    }

    // Admin-created staking package. Only approved validators stake into one.
    struct Package {
        uint256 id;
        string  name;
        uint256 minAmount;
        uint256 lockSeconds;
        uint256 aprBps;
        bool    active;
        bool    allowEarlyWithdraw; // retained for ABI/layout compat (unused in v9)
    }

    // Admin curve entry: at POOL volume >= minPoolWei the validator gets
    // aprBps APR (informational) and gasShareBps of each transaction's fee.
    // Highest matching tier wins.
    struct Tier {
        uint256 minPoolWei;
        uint256 aprBps;
        uint256 gasShareBps;
    }

    // ───────── Storage ─────────
    address public admin;                       // slot 0
    address public pendingAdmin;                // slot 1
    uint256 public pendingAdminFromTs;          // slot 2

    uint256 public minValidatorStake = 10 ether;// slot 3
    uint256 public constant BPS_DENOM = 10000;

    // NOTE: gas PRICING uses Nethermind's default Ethereum mechanism (EIP-1559
    // base fee + priority fee). This contract only governs how the fees the
    // producer collects are SPLIT (validator gas-share by tier vs. admin
    // residual) via creditTxFee.

    bool public paused;                         // slot 4
    uint256 private _reentrancyStatus;          // slot 5

    // Validator registry. INTERNAL: the auto-generated public getter for the
    // 14-field struct blows the EVM stack (use getValidatorInfo /
    // pendingValidatorProfit views instead). The consensus hook reads the
    // slot directly, so visibility is irrelevant to it.
    mapping(address => Validator) internal validators;   // slot 6 (consensus hook)
    address[] public validatorList;                       // slot 7
    mapping(string => address) public codeToValidator;    // slot 8  public code → operator
    uint256 public totalGasShareBps;                      // slot 9  Σ active validators' gasShareBps

    // Delegation positions: validator → array of positions. Every deposit
    // appends a NEW position (multiple per delegator).
    mapping(address => Position[]) public delegations;    // slot 10

    // slot 11 — RETIRED (was delegationIndexPlus1). Kept so slots 12-19 do
    // not shift; never written in v9.
    mapping(address => mapping(address => uint256)) private _retiredDelegationIndexPlus1;

    // Admin packages
    mapping(uint256 => Package) public packages;          // slot 12
    uint256[] public packageIds;                          // slot 13
    uint256 public nextPackageId = 1;                     // slot 14

    // Admin tier curve (sorted ascending by minPoolWei)
    Tier[] public tiers;                                  // slot 15

    // Reward pool funds profit payouts; admin pool is residual.
    uint256 public rewardPool;                            // slot 16
    uint256 public adminAccumulatedFees;                  // slot 17 (consensus hook)
    uint256 public donationsPool;                         // slot 18

    // The validator's public OFFER display text (free text).
    mapping(address => string) public validatorOffer;     // slot 19 (consensus hook)

    // ── v9 NEW top-level state (slots ≥ 20) ──
    // Validator-published delegator APR (bps), capped at the selected
    // package's APR. Snapshotted into each position at deposit.
    mapping(address => uint256) public delegatorRateBps;  // slot 20
    // Validator-assigned display name per delegator (covers all positions).
    mapping(address => mapping(address => string)) public delegatorLabel; // slot 21
    // Lifetime manual gifts (distributeToDelegator): validator → delegator → wei.
    mapping(address => mapping(address => uint256)) public distributedTotal; // slot 22

    // ── TWO-TIER marketing model (APPENDED top-level slots ≥ 23) ──
    // Tier-2 packages each validator publishes to its delegators. Delegating
    // now REQUIRES choosing one of the target validator's packages.
    mapping(address => VPackage[]) public validatorPackages; // slot 23
    // Validator public profile — JSON string the validator page renders
    // ({company, contact, address, website, about}). Max 1000 chars.
    mapping(address => string) public validatorProfile;      // slot 24

    // ── ONE PACKAGE PER DELEGATOR (APPENDED top-level slots ≥ 25) ──
    // A delegator may hold open positions in exactly ONE package of ONE
    // validator at a time. Top-ups of the SAME validator+package are allowed;
    // joining a different validator/package requires withdrawing the current
    // one fully first (outstanding principal reaches 0 → both keys clear).
    mapping(address => address) public delegatorActiveValidator;    // slot 25
    mapping(address => uint256) public delegatorActiveVpkgIdxPlus1; // slot 26 (vpkgIdx + 1; 0 = none)
    mapping(address => uint256) public delegatorOutstandingWei;     // slot 27 (sum of open principal)

    // ───────── Events ─────────
    event ValidatorApplied(address indexed operator, uint256 stake);
    event ValidatorApproved(address indexed operator, string code);
    event ValidatorRejected(address indexed operator);
    event ValidatorSuspended(address indexed operator, string reason);
    event ValidatorStakeWithdrawn(address indexed operator, uint256 amount);
    event ValidatorCodeSet(address indexed operator, string code);
    event GasShareUpdated(address indexed operator, uint256 gasShareBps, uint256 aprBps);
    event PackageSelected(address indexed operator, uint256 indexed packageId, uint256 unlockAt);
    event ValidatorProfitClaimed(address indexed operator, uint256 amount);
    event DelegatorRateSet(address indexed operator, uint256 rateBps);
    event ValidatorPackageAdded(address indexed operator, uint256 indexed id, string name,
                                uint256 lockSeconds, uint256 minAmountWei, uint256 rateBps, uint256 penaltyBps);
    event ValidatorPackageUpdated(address indexed operator, uint256 idx, bool active);
    event ValidatorProfileSet(address indexed operator);

    event Delegated(address indexed validator, address indexed delegator, uint256 amount, uint256 newPool);
    event Undelegated(address indexed validator, address indexed delegator, uint256 amount, uint256 newPool);
    event PositionWithdrawn(address indexed validator, address indexed delegator, uint256 posIdx,
                            uint256 amount, uint256 profit, uint256 penalty, bool byValidator);
    event DelegatorLabeled(address indexed validator, address indexed delegator, string label);
    event RewardDistributed(address indexed validator, address indexed delegator, uint256 amount);

    event PackageAdded(uint256 indexed id, string name, uint256 minAmount, uint256 lockSeconds, uint256 aprBps);
    event PackageUpdated(uint256 indexed id, bool active);
    event TiersUpdated(uint256 count);

    event TxFeeCredited(address indexed validator, uint256 totalFee, uint256 validatorShare, uint256 adminShare);
    event FeesWithdrawn(address indexed beneficiary, uint256 amount);
    event AdminFeesWithdrawn(address indexed admin, uint256 amount);
    event RewardPoolFunded(address indexed by, uint256 amount, uint256 newPool);
    event RewardPoolPulled(uint256 fromAdminPool, uint256 newRewardPool);
    event Paused(bool paused);
    event AdminTransferProposed(address indexed pending, uint256 activatesAt);
    event AdminTransferCancelled(address indexed previousPending);
    event AdminTransferred(address indexed previous, address indexed current);

    // ───────── Modifiers ─────────
    modifier onlyAdmin() { require(msg.sender == admin, "UNP: not admin"); _; }
    modifier validatorExists(address op) { require(validators[op].registeredAt != 0, "UNP: validator !exist"); _; }
    modifier whenNotPaused() { require(!paused, "UNP: paused"); _; }
    modifier nonReentrant() {
        require(_reentrancyStatus == 0, "UNP: reentrancy");
        _reentrancyStatus = 1; _; _reentrancyStatus = 0;
    }

    constructor() {
        admin = msg.sender;
        // Genesis validator = admin, auto-ACTIVE, code "ADMIN", no stake.
        validators[msg.sender] = Validator({
            operator: msg.sender, publicKey: "",
            status: ValidatorStatus.ACTIVE, code: "ADMIN",
            selfStake: 0, delegatedTotal: 0, selectedPackageId: 0, stakeUnlockTs: 0,
            gasShareBps: 1000, aprBps: 0, accumulatedFees: 0,
            registeredAt: block.timestamp,
            lastAccrual: block.timestamp, accruedProfit: 0
        });
        validatorList.push(msg.sender);
        codeToValidator["ADMIN"] = msg.sender;
        totalGasShareBps = 1000;
        emit ValidatorApplied(msg.sender, 0);
        emit ValidatorApproved(msg.sender, "ADMIN");
    }

    // ═══════════════ ADMIN ════════════════════════════════════
    function setMinValidatorStake(uint256 v) external onlyAdmin { minValidatorStake = v; }

    function setPaused(bool p) external onlyAdmin { paused = p; emit Paused(p); }

    /// Admin sets the full tier curve at once. Must be ascending by minPoolWei.
    /// At POOL volume V (selfStake + delegatedTotal) the validator gets the
    /// highest tier whose minPoolWei <= V.
    function setTiers(uint256[] calldata minPoolWei, uint256[] calldata aprBps, uint256[] calldata gasShareBps) external onlyAdmin {
        require(minPoolWei.length == aprBps.length && aprBps.length == gasShareBps.length, "UNP: len mismatch");
        delete tiers;
        uint256 prev = 0;
        for (uint256 i = 0; i < minPoolWei.length; i++) {
            if (i > 0) require(minPoolWei[i] > prev, "UNP: tiers not ascending");
            require(gasShareBps[i] < BPS_DENOM, "UNP: gasShare >= 100%");
            tiers.push(Tier({ minPoolWei: minPoolWei[i], aprBps: aprBps[i], gasShareBps: gasShareBps[i] }));
            prev = minPoolWei[i];
        }
        emit TiersUpdated(tiers.length);
    }
    function getTierCount() external view returns (uint256) { return tiers.length; }

    /// Resolve the tier for a given POOL volume (returns aprBps, gasShareBps).
    function tierFor(uint256 poolWei) public view returns (uint256 aprBps, uint256 gasShareBps) {
        for (uint256 i = tiers.length; i > 0; i--) {
            if (poolWei >= tiers[i - 1].minPoolWei) {
                return (tiers[i - 1].aprBps, tiers[i - 1].gasShareBps);
            }
        }
        return (0, 0);
    }

    // ── Validator lifecycle (admin) ──
    function approveValidator(address op, string calldata code) external onlyAdmin validatorExists(op) {
        Validator storage v = validators[op];
        require(v.status == ValidatorStatus.PENDING || v.status == ValidatorStatus.SUSPENDED, "UNP: bad state");
        require(bytes(code).length > 0, "UNP: empty code");
        require(codeToValidator[code] == address(0) || codeToValidator[code] == op, "UNP: code taken");
        // Clear any previous code mapping for this operator.
        if (bytes(v.code).length > 0 && codeToValidator[v.code] == op) codeToValidator[v.code] = address(0);
        v.code = code;
        codeToValidator[code] = op;
        v.status = ValidatorStatus.ACTIVE;
        v.lastAccrual = block.timestamp; // daily-profit clock starts at approval
        _applyTier(op);
        emit ValidatorApproved(op, code);
        emit ValidatorCodeSet(op, code);
    }
    function setValidatorCode(address op, string calldata code) external onlyAdmin validatorExists(op) {
        require(bytes(code).length > 0, "UNP: empty code");
        require(codeToValidator[code] == address(0) || codeToValidator[code] == op, "UNP: code taken");
        Validator storage v = validators[op];
        if (bytes(v.code).length > 0 && codeToValidator[v.code] == op) codeToValidator[v.code] = address(0);
        v.code = code; codeToValidator[code] = op;
        emit ValidatorCodeSet(op, code);
    }
    function rejectValidator(address op) external onlyAdmin validatorExists(op) {
        _accrueValidator(op); // keep profit earned while ACTIVE
        Validator storage v = validators[op];
        if (v.status == ValidatorStatus.ACTIVE) totalGasShareBps -= v.gasShareBps;
        v.status = ValidatorStatus.REJECTED;
        v.gasShareBps = 0;
        emit ValidatorRejected(op);
    }
    function suspendValidator(address op, string calldata reason) external onlyAdmin validatorExists(op) {
        _accrueValidator(op); // keep profit earned while ACTIVE
        Validator storage v = validators[op];
        if (v.status == ValidatorStatus.ACTIVE) totalGasShareBps -= v.gasShareBps;
        v.status = ValidatorStatus.SUSPENDED;
        v.gasShareBps = 0;
        emit ValidatorSuspended(op, reason);
    }

    // ── Admin packages ──
    function addPackage(string calldata name, uint256 minAmt, uint256 lockSecs, uint256 aprBps, bool allowEarly) external onlyAdmin {
        uint256 id = nextPackageId++;
        packages[id] = Package(id, name, minAmt, lockSecs, aprBps, true, allowEarly);
        packageIds.push(id);
        emit PackageAdded(id, name, minAmt, lockSecs, aprBps);
    }
    function setPackageActive(uint256 id, bool active) external onlyAdmin {
        require(packages[id].id != 0, "UNP: !pkg");
        packages[id].active = active;
        emit PackageUpdated(id, active);
    }
    function getPackageCount() external view returns (uint256) { return packageIds.length; }

    // ═══════════════ VALIDATORS ═══════════════════════════════
    /// Apply to become a validator by staking THROUGH an admin package.
    /// Caller must run the node whose pubkey is provided. The package is
    /// selected at apply time and the stake locks for the package term.
    /// Admin approves before any fees or profit are earned.
    function applyAsValidator(bytes calldata pubKey, uint256 packageId) external payable whenNotPaused {
        require(validators[msg.sender].registeredAt == 0, "UNP: already applied");
        Package storage p = packages[packageId];
        require(p.id != 0 && p.active, "UNP: bad pkg");
        require(msg.value >= minValidatorStake, "UNP: stake < min");
        require(msg.value >= p.minAmount, "UNP: < minAmount");
        uint256 unlockTs = block.timestamp + p.lockSeconds;
        validators[msg.sender] = Validator({
            operator: msg.sender, publicKey: pubKey,
            status: ValidatorStatus.PENDING, code: "",
            selfStake: msg.value, delegatedTotal: 0, selectedPackageId: packageId, stakeUnlockTs: unlockTs,
            gasShareBps: 0, aprBps: 0, accumulatedFees: 0,
            registeredAt: block.timestamp,
            lastAccrual: block.timestamp, accruedProfit: 0
        });
        validatorList.push(msg.sender);
        emit ValidatorApplied(msg.sender, msg.value);
        emit PackageSelected(msg.sender, packageId, unlockTs);
    }

    /// ACTIVE (or BELOW_MIN — so an auto-removed validator can stake again to
    /// recover) validators TOP UP the SAME selected package only — one package
    /// at a time. The whole stake re-locks for the same package's term.
    /// (If no package is selected — e.g. after a full stake withdrawal — the
    /// given package becomes the selection, like a fresh apply.)
    function validatorStakeInPackage(uint256 packageId) external payable whenNotPaused validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        require(v.status == ValidatorStatus.ACTIVE || v.status == ValidatorStatus.BELOW_MIN, "UNP: not approved validator");
        Package storage p = packages[packageId];
        require(p.id != 0 && p.active, "UNP: bad pkg");
        require(v.selectedPackageId == 0 || v.selectedPackageId == packageId, "UNP: top-up must use selected package");
        require(msg.value > 0, "UNP: zero");
        _accrueValidator(msg.sender); // settle profit at the old balance first
        v.selfStake += msg.value;
        v.selectedPackageId = packageId;
        v.stakeUnlockTs = block.timestamp + p.lockSeconds;
        _applyTier(msg.sender);
        emit PackageSelected(msg.sender, packageId, v.stakeUnlockTs);
    }

    /// Switch the selected package (does not move funds; re-locks selfStake to
    /// the new package term). ONE PACKAGE AT A TIME: only allowed once the
    /// current term has fully ended — no early bypass.
    function selectPackage(uint256 packageId) external whenNotPaused validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        require(v.status == ValidatorStatus.ACTIVE || v.status == ValidatorStatus.BELOW_MIN, "UNP: not approved validator");
        Package storage np = packages[packageId];
        require(np.id != 0 && np.active, "UNP: bad pkg");
        require(block.timestamp >= v.stakeUnlockTs, "UNP: current term not ended");
        _accrueValidator(msg.sender); // settle profit at the old package APR first
        v.selectedPackageId = packageId;
        v.stakeUnlockTs = block.timestamp + np.lockSeconds;
        emit PackageSelected(msg.sender, packageId, v.stakeUnlockTs);
    }

    /// Withdraw validator self-stake principal after rejection/suspension or
    /// once the package lock elapsed. Any accrued daily profit is paid out
    /// too (from the reward pool, admin fallback). Non-custodial.
    function withdrawValidatorStake() external nonReentrant whenNotPaused validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        bool exited = v.status == ValidatorStatus.REJECTED || v.status == ValidatorStatus.SUSPENDED;
        require(exited || block.timestamp >= v.stakeUnlockTs, "UNP: still locked");
        _accrueValidator(msg.sender);
        uint256 amt = v.selfStake;
        require(amt > 0, "UNP: no self stake");

        uint256 reward = v.accruedProfit;
        v.accruedProfit = 0;
        v.selfStake = 0;
        v.selectedPackageId = 0;
        // Recompute tier from the remaining pool (delegatedTotal) — a
        // still-ACTIVE validator whose pool fell under the minimum drops to
        // BELOW_MIN. No-op for REJECTED/SUSPENDED (gasShareBps already zero).
        _applyTier(msg.sender);

        if (reward > 0) _payFromRewardPool(reward);

        // Exit cleanup: a REJECTED/SUSPENDED validator with no delegated funds
        // left is fully cleared so the operator can re-apply later. (If
        // delegators still hold positions, the entry must survive — their
        // withdrawPosition path reads it — so cleanup waits until they exit.)
        if (exited && v.delegatedTotal == 0) {
            if (bytes(v.code).length > 0 && codeToValidator[v.code] == msg.sender) {
                delete codeToValidator[v.code];
            }
            uint256 n = validatorList.length;
            for (uint256 i = 0; i < n; ++i) {
                if (validatorList[i] == msg.sender) {
                    if (i != n - 1) validatorList[i] = validatorList[n - 1];
                    validatorList.pop();
                    break;
                }
            }
            delete validators[msg.sender];
        }

        uint256 payout = amt + reward;
        (bool ok,) = msg.sender.call{value: payout}(""); require(ok, "UNP: send fail");
        emit ValidatorStakeWithdrawn(msg.sender, payout);
    }

    /// DAILY PROFIT accrual: package APR on the validator's selfStake for the
    /// elapsed time, banked into accruedProfit. Runs before every stake /
    /// status / package mutation so past time is always settled at the rates
    /// and balances that were in force. Only an ACTIVE validator with a
    /// selected package accrues.
    function _accrueValidator(address op) internal {
        Validator storage v = validators[op];
        if (v.registeredAt == 0) return;
        uint256 last = v.lastAccrual;
        if (last == 0) { v.lastAccrual = block.timestamp; return; }
        if (block.timestamp <= last) return;
        uint256 elapsed = block.timestamp - last;
        if (v.status == ValidatorStatus.ACTIVE && v.selectedPackageId != 0 && v.selfStake > 0) {
            uint256 aprBps = packages[v.selectedPackageId].aprBps;
            v.accruedProfit += (v.selfStake * aprBps * elapsed) / (BPS_DENOM * 365 days);
        }
        v.lastAccrual = block.timestamp;
    }

    /// Claim the accrued daily profit (any time). Paid from the reward pool,
    /// topped up from the admin pool when short.
    function claimValidatorProfit() external nonReentrant whenNotPaused validatorExists(msg.sender) {
        _accrueValidator(msg.sender);
        Validator storage v = validators[msg.sender];
        uint256 amt = v.accruedProfit;
        require(amt > 0, "UNP: nothing accrued");
        v.accruedProfit = 0;
        _payFromRewardPool(amt);
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "UNP: send fail");
        emit ValidatorProfitClaimed(msg.sender, amt);
    }

    /// Live view: accrued profit including the un-banked elapsed time.
    function pendingValidatorProfit(address op) external view returns (uint256) {
        Validator storage v = validators[op];
        uint256 acc = v.accruedProfit;
        if (v.lastAccrual != 0 && block.timestamp > v.lastAccrual &&
            v.status == ValidatorStatus.ACTIVE && v.selectedPackageId != 0 && v.selfStake > 0) {
            acc += (v.selfStake * packages[v.selectedPackageId].aprBps * (block.timestamp - v.lastAccrual))
                   / (BPS_DENOM * 365 days);
        }
        return acc;
    }

    /// Validator publishes the on-chain APR it pays delegators, capped at the
    /// selected package's APR. New positions snapshot this rate; existing
    /// positions are grandfathered at their deposit-time rate.
    function setDelegatorRate(uint256 rateBps) external validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        require(v.selectedPackageId != 0, "UNP: no package selected");
        require(rateBps <= packages[v.selectedPackageId].aprBps, "UNP: rate > package APR");
        delegatorRateBps[msg.sender] = rateBps;
        emit DelegatorRateSet(msg.sender, rateBps);
    }

    // ═══════════════ TIER-2: VALIDATOR PACKAGES ═══════════════
    /// A validator publishes a delegation package (tier-2). The rate is
    /// ANNUAL bps and may never exceed the validator's tier-1 (admin)
    /// package APR; the early-exit penalty is capped at 20%.
    function addValidatorPackage(
        string calldata name, uint256 lockSeconds, uint256 minAmountWei,
        uint256 rateBps, uint256 penaltyBps
    ) external whenNotPaused validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        require(v.status == ValidatorStatus.ACTIVE || v.status == ValidatorStatus.BELOW_MIN, "UNP: not approved validator");
        require(v.selectedPackageId != 0, "UNP: no package selected");
        require(rateBps <= packages[v.selectedPackageId].aprBps, "UNP: rate > package APR");
        require(penaltyBps <= 2000, "UNP: penalty > 20%");
        require(bytes(name).length > 0 && bytes(name).length <= 64, "UNP: bad name");
        require(minAmountWei > 0, "UNP: zero min");
        uint256 id = validatorPackages[msg.sender].length + 1;
        validatorPackages[msg.sender].push(VPackage({
            id: id, name: name, lockSeconds: lockSeconds,
            minAmountWei: minAmountWei, rateBps: rateBps,
            penaltyBps: penaltyBps, active: true
        }));
        emit ValidatorPackageAdded(msg.sender, id, name, lockSeconds, minAmountWei, rateBps, penaltyBps);
    }

    /// Enable/disable one of the caller's tier-2 packages. Existing
    /// positions are untouched (terms are snapshotted at deposit).
    function setValidatorPackageActive(uint256 idx, bool active) external validatorExists(msg.sender) {
        require(idx < validatorPackages[msg.sender].length, "UNP: bad vpkg");
        validatorPackages[msg.sender][idx].active = active;
        emit ValidatorPackageUpdated(msg.sender, idx, active);
    }

    function getValidatorPackageCount(address op) external view returns (uint256) {
        return validatorPackages[op].length;
    }

    /// Validator publishes its public profile (JSON: company, contact,
    /// address, website, about) rendered on its validator page.
    function setProfile(string calldata profile) external validatorExists(msg.sender) {
        require(bytes(profile).length <= 1000, "UNP: profile > 1000");
        validatorProfile[msg.sender] = profile;
        emit ValidatorProfileSet(msg.sender);
    }

    /// Pay `amount` out of the reward pool, pulling the deficit from the
    /// admin pool when the reward pool is short.
    function _payFromRewardPool(uint256 amount) internal {
        if (rewardPool < amount) {
            uint256 deficit = amount - rewardPool;
            require(adminAccumulatedFees >= deficit, "UNP: reward pool insufficient");
            adminAccumulatedFees -= deficit; rewardPool += deficit;
            emit RewardPoolPulled(deficit, rewardPool);
        }
        rewardPool -= amount;
    }

    /// Recompute the validator's tier-driven APR + gasShare from the ONE POOL
    /// (selfStake + delegatedTotal). Called on EVERY balance change — this is
    /// also where the BELOW_MIN auto-removal / auto-recovery lifecycle lives:
    ///   ACTIVE    + pool <  min → BELOW_MIN (gas share pulled, earns nothing)
    ///   BELOW_MIN + pool >= min → ACTIVE    (tier + gas share restored)
    /// The genesis admin validator is exempt from the below-min demotion —
    /// it is ACTIVE by construction with zero stake and takes no delegators.
    function _applyTier(address op) internal {
        Validator storage v = validators[op];
        uint256 pool = v.selfStake + v.delegatedTotal;
        if (v.status == ValidatorStatus.ACTIVE && pool < minValidatorStake && op != admin) {
            // Auto-removal: the pool fell below the network minimum.
            totalGasShareBps -= v.gasShareBps;
            v.gasShareBps = 0;
            v.aprBps = 0;
            v.status = ValidatorStatus.BELOW_MIN;
            emit ValidatorSuspended(op, "below minimum stake");
            return;
        }
        if (v.status == ValidatorStatus.BELOW_MIN && pool >= minValidatorStake) {
            // Auto-recovery: pool refilled — restore ACTIVE, then re-tier.
            v.status = ValidatorStatus.ACTIVE;
            v.lastAccrual = block.timestamp; // profit clock restarts on recovery
        }
        if (v.status != ValidatorStatus.ACTIVE) return;
        (uint256 aprBps, uint256 gasBps) = tierFor(pool);
        totalGasShareBps = totalGasShareBps - v.gasShareBps + gasBps;
        require(totalGasShareBps < BPS_DENOM, "UNP: aggregate gasShare >= 100%");
        v.gasShareBps = gasBps;
        v.aprBps = aprBps;
        emit GasShareUpdated(op, gasBps, aprBps);
    }

    /// Admin can force a tier re-eval for a validator (e.g. after editing tiers).
    function refreshTier(address op) external onlyAdmin validatorExists(op) {
        _accrueValidator(op);
        _applyTier(op);
    }

    // ═══════════════ DELEGATORS ═══════════════════════════════
    /// Fund a validator's pool by their public APOS code, INTO one of the
    /// validator's published tier-2 packages (vpkgIdx = array index). Every
    /// deposit creates a NEW position snapshotting the package's terms —
    /// rate, lock and penalty are grandfathered forever. Deposits raise the
    /// ONE POOL and therefore the tier directly.
    function delegateByCode(string calldata code, uint256 vpkgIdx) external payable whenNotPaused {
        address op = codeToValidator[code];
        require(op != address(0), "UNP: unknown code");
        _delegate(op, vpkgIdx, msg.value);
    }
    function delegate(address validator, uint256 vpkgIdx) external payable whenNotPaused {
        require(validators[validator].registeredAt != 0, "UNP: validator !exist");
        _delegate(validator, vpkgIdx, msg.value);
    }
    function _delegate(address op, uint256 vpkgIdx, uint256 amount) internal {
        require(amount > 0, "UNP: zero");
        Validator storage v = validators[op];
        // BELOW_MIN is delegatable on purpose: delegator deposits refill the
        // pool and auto-restore the validator to ACTIVE.
        require(v.status == ValidatorStatus.ACTIVE || v.status == ValidatorStatus.BELOW_MIN, "UNP: validator !active");
        require(op != admin, "UNP: admin takes no delegators");
        require(vpkgIdx < validatorPackages[op].length, "UNP: bad vpkg");
        VPackage storage vp = validatorPackages[op][vpkgIdx];
        require(vp.active, "UNP: vpkg inactive");
        require(amount >= vp.minAmountWei, "UNP: below package minimum");
        // ONE PACKAGE PER DELEGATOR: only top-ups of the SAME validator+package
        // are allowed while any principal is outstanding.
        {
            address cur = delegatorActiveValidator[msg.sender];
            require(cur == address(0) || (cur == op && delegatorActiveVpkgIdxPlus1[msg.sender] == vpkgIdx + 1),
                unicode"UNP: one package per delegator — withdraw fully to switch");
            delegatorActiveValidator[msg.sender] = op;
            delegatorActiveVpkgIdxPlus1[msg.sender] = vpkgIdx + 1;
            delegatorOutstandingWei[msg.sender] += amount;
        }
        _accrueValidator(op);
        delegations[op].push(Position({
            delegator: msg.sender, amount: amount,
            rateBps: vp.rateBps, since: block.timestamp,
            withdrawn: 0, label: "",
            vpkgId: vp.id, lockSeconds: vp.lockSeconds, penaltyBps: vp.penaltyBps
        }));
        v.delegatedTotal += amount;
        _applyTier(op);
        emit Delegated(op, msg.sender, amount, v.selfStake + v.delegatedTotal);
    }

    /// Shared position-exit math: pays principal (− optional penalty) +
    /// accrued profit to the position's delegator.
    function _exitPosition(address op, uint256 posIdx, uint256 amount, bool applyPenalty, bool byValidator) internal {
        require(posIdx < delegations[op].length, "UNP: bad position");
        Position storage pos = delegations[op][posIdx];
        require(amount > 0 && amount <= pos.amount, "UNP: bad amount");
        Validator storage v = validators[op];

        uint256 elapsed = block.timestamp > pos.since ? block.timestamp - pos.since : 0;
        // Profit is amount-proportional at the GRANDFATHERED position rate.
        uint256 profit = (amount * pos.rateBps * elapsed) / (BPS_DENOM * 365 days);
        uint256 penalty = 0;
        if (applyPenalty && elapsed < pos.lockSeconds) {
            // Early withdrawal (before the position's snapshotted lock term
            // ends): the package's penaltyBps of the withdrawn principal
            // goes to the pool's validator. Replaces the old global 30d/1%.
            penalty = (amount * pos.penaltyBps) / BPS_DENOM;
            v.accumulatedFees += penalty;
        }

        pos.amount -= amount;
        pos.withdrawn += amount;
        // ONE PACKAGE PER DELEGATOR: shrink the outstanding principal; once it
        // reaches 0 the delegator is free to join a different validator/package.
        {
            address delegator = pos.delegator;
            delegatorOutstandingWei[delegator] -= amount;
            if (delegatorOutstandingWei[delegator] == 0) {
                delete delegatorActiveValidator[delegator];
                delete delegatorActiveVpkgIdxPlus1[delegator];
            }
        }
        _accrueValidator(op);
        v.delegatedTotal -= amount;
        _applyTier(op);

        if (profit > 0) _payFromRewardPool(profit);

        uint256 payout = amount - penalty + profit;
        (bool ok,) = pos.delegator.call{value: payout}(""); require(ok, "UNP: send fail");
        emit PositionWithdrawn(op, pos.delegator, posIdx, amount, profit, penalty, byValidator);
        emit Undelegated(op, pos.delegator, amount, v.selfStake + v.delegatedTotal);
    }

    /// DELEGATOR SELF-WITHDRAW: pull principal (any part) of one of YOUR
    /// positions + its accrued profit. Exiting before the position's lock
    /// term ends pays the package's snapshotted penaltyBps on the withdrawn
    /// principal (kept by the validator).
    function withdrawPosition(address op, uint256 posIdx, uint256 amount) external nonReentrant whenNotPaused validatorExists(op) {
        require(posIdx < delegations[op].length, "UNP: bad position");
        require(delegations[op][posIdx].delegator == msg.sender, "UNP: not your position");
        _exitPosition(op, posIdx, amount, true, false);
    }

    /// VALIDATOR RELEASE: the validator returns principal of one of its
    /// delegators' positions — no early penalty; accrued profit is paid too.
    function releaseToDelegator(address delegator, uint256 posIdx, uint256 amount) external nonReentrant whenNotPaused validatorExists(msg.sender) {
        require(posIdx < delegations[msg.sender].length, "UNP: bad position");
        require(delegations[msg.sender][posIdx].delegator == delegator, "UNP: not that delegator's position");
        _exitPosition(msg.sender, posIdx, amount, false, true);
    }

    /// Validator publishes/updates their public offer text (display only —
    /// the binding number is delegatorRateBps).
    function setOffer(string calldata offer) external validatorExists(msg.sender) {
        validatorOffer[msg.sender] = offer;
    }

    /// Validator labels one of its delegators (covers all their positions).
    function labelDelegator(address delegator, string calldata label) external validatorExists(msg.sender) {
        delegatorLabel[msg.sender][delegator] = label;
        emit DelegatorLabeled(msg.sender, delegator, label);
    }

    /// Validator pays a manual gift to one of its delegators. Amount comes
    /// from msg.value (the validator's own funds / withdrawn earnings).
    /// Recorded on-chain so the panel can show distribution history.
    function distributeToDelegator(address delegator) external payable nonReentrant whenNotPaused validatorExists(msg.sender) {
        require(msg.value > 0, "UNP: zero");
        distributedTotal[msg.sender][delegator] += msg.value;
        (bool ok,) = delegator.call{value: msg.value}(""); require(ok, "UNP: send fail");
        emit RewardDistributed(msg.sender, delegator, msg.value);
    }

    function getDelegatorCount(address op) external view returns (uint256) { return delegations[op].length; }

    /// Live view: a position's accrued (unpaid) profit on its REMAINING
    /// principal, plus the early-penalty deadline (= unlock time of the
    /// position's snapshotted lock term).
    function positionProfit(address op, uint256 posIdx) external view returns (uint256 accrued, uint256 earlyUntil) {
        Position storage pos = delegations[op][posIdx];
        uint256 elapsed = block.timestamp > pos.since ? block.timestamp - pos.since : 0;
        accrued = (pos.amount * pos.rateBps * elapsed) / (BPS_DENOM * 365 days);
        earlyUntil = pos.since + pos.lockSeconds;
    }

    // ═══════════════ FEE COLLECTION ═══════════════════════════
    /// Called by the producer (or admin) to credit a block's fees. The producing
    /// validator gets gasShareBps; the remainder goes to the admin pool.
    function creditTxFee(address sender, address /*target*/) external payable whenNotPaused {
        require(msg.sender == sender || msg.sender == admin, "UNP: bad sender");
        uint256 totalFee = msg.value;
        if (totalFee == 0) return;
        uint256 validatorShare = 0;
        Validator storage v = validators[sender];
        if (v.status == ValidatorStatus.ACTIVE && v.gasShareBps > 0) {
            validatorShare = (totalFee * v.gasShareBps) / BPS_DENOM;
            v.accumulatedFees += validatorShare;
        }
        uint256 adminShare = totalFee - validatorShare;
        adminAccumulatedFees += adminShare;
        emit TxFeeCredited(sender, totalFee, validatorShare, adminShare);
    }

    /// Validator withdraws its accrued gas-fee share (+ delegator early
    /// penalties) at any time.
    function withdrawValidatorFees() external nonReentrant whenNotPaused validatorExists(msg.sender) {
        Validator storage v = validators[msg.sender];
        uint256 amt = v.accumulatedFees; require(amt > 0, "UNP: zero");
        v.accumulatedFees = 0;
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "UNP: send fail");
        emit FeesWithdrawn(msg.sender, amt);
    }

    function fundRewardPool() external payable {
        require(msg.value > 0, "UNP: zero");
        rewardPool += msg.value;
        emit RewardPoolFunded(msg.sender, msg.value, rewardPool);
    }

    function withdrawAdminFees(address payable to, uint256 amount) external onlyAdmin nonReentrant whenNotPaused {
        require(amount <= adminAccumulatedFees, "UNP: > pool");
        adminAccumulatedFees -= amount;
        (bool ok,) = to.call{value: amount}(""); require(ok, "UNP: send fail");
        emit AdminFeesWithdrawn(to, amount);
    }

    // ═══════════════ ADMIN TRANSFER (24h timelock) ════════════
    function proposeAdminTransfer(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "UNP: zero");
        pendingAdmin = newAdmin;
        pendingAdminFromTs = block.timestamp + 24 hours;
        emit AdminTransferProposed(newAdmin, pendingAdminFromTs);
    }
    function cancelAdminTransfer() external onlyAdmin {
        address prev = pendingAdmin;
        pendingAdmin = address(0); pendingAdminFromTs = 0;
        emit AdminTransferCancelled(prev);
    }
    function acceptAdminTransfer() external {
        require(msg.sender == pendingAdmin, "UNP: not pending");
        require(pendingAdminFromTs != 0 && block.timestamp >= pendingAdminFromTs, "UNP: too early");
        address prev = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0); pendingAdminFromTs = 0;
        emit AdminTransferred(prev, admin);
    }

    // ═══════════════ READ HELPERS ═════════════════════════════
    function isValidatorActive(address op) external view returns (bool) {
        return validators[op].status == ValidatorStatus.ACTIVE;
    }
    function getValidatorCount() external view returns (uint256) { return validatorList.length; }
    function getValidatorInfo(address op) external view returns (
        ValidatorStatus status, string memory code, uint256 selfStake,
        uint256 delegatedTotal, uint256 selectedPackageId, uint256 gasShareBps,
        uint256 aprBps, uint256 accumulatedFees
    ) {
        Validator storage v = validators[op];
        return (v.status, v.code, v.selfStake, v.delegatedTotal, v.selectedPackageId, v.gasShareBps, v.aprBps, v.accumulatedFees);
    }

    receive() external payable { donationsPool += msg.value; }
}
