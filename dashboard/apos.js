// ═══════════════════════════════════════════════════════════════════
// APOS Registry — server-side endpoints
//
// Exports a single `mount(app, ctx)` function. ctx provides:
//   { web3Ref, requireAuth, dataDir, getConfig, saveConfig, sendAndWait,
//     realChainId, log }
//
// The frontend uses these endpoints to:
//   - Deploy UNPRegistry with the admin's private key
//   - Apply / approve / reject nodes & contracts
//   - Manage staking packages
//   - Read all on-chain state for the admin dashboard & node operator portal
//   - Forward collected validator fees to creditTxFee() (off-chain shim that
//     mimics the on-chain consensus-plugin behaviour described in the spec)
// ═══════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

let BUILD = null;
function loadBuild() {
  if (BUILD) return BUILD;
  const p = path.join(__dirname, 'apos-registry-build.json');
  if (!fs.existsSync(p)) {
    throw new Error('apos-registry-build.json missing — run: node apos-compile.js');
  }
  BUILD = JSON.parse(fs.readFileSync(p, 'utf8'));
  return BUILD;
}

function getRegistry(web3, addr) {
  const b = loadBuild();
  return new web3.eth.Contract(b.abi, addr);
}

let POINTER_BUILD = null;
function loadPointerBuild() {
  if (POINTER_BUILD) return POINTER_BUILD;
  const p = path.join(__dirname, 'apos-pointer-build.json');
  if (!fs.existsSync(p)) {
    throw new Error('apos-pointer-build.json missing — run: node apos-compile.js');
  }
  POINTER_BUILD = JSON.parse(fs.readFileSync(p, 'utf8'));
  return POINTER_BUILD;
}
function getPointer(web3, addr) {
  return new web3.eth.Contract(loadPointerBuild().abi, addr);
}

function mount(app, ctx) {
  const { requireAuth } = ctx;
  const log = ctx.log || ((...a) => console.log('[apos]', ...a));

  // v7.11.9 — proposeRegistry + verify-and-retry helper.
  // The previous code in /api/apos/deploy and /api/apos/deploy-pointer
  // fired proposeRegistry once and trusted the result. If the tx was
  // submitted but never took effect (transient RPC blip, nonce race),
  // the deploy returned success while pointer.registry() stayed 0x0
  // forever — silently breaking L2 fee distribution because the C# hook
  // resolves the registry through the pointer. Now we send the tx, read
  // pointer.registry() back, retry once with a fresh nonce if still
  // unset, and report verified=true/false in the response so the caller
  // can fail loudly.
  //
  // Returns { txHash, verified, currentRegistry, attempts, lastError }
  async function proposeRegistryAndVerify(web3, pointerAddr, registryAddr, key, chainId) {
    const ptr = getPointer(web3, pointerAddr);
    const acct = web3.eth.accounts.privateKeyToAccount(key);
    let lastTx = null, lastErr = null, current = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const data = ptr.methods.proposeRegistry(registryAddr).encodeABI();
        const nonce = await web3.eth.getTransactionCount(acct.address, 'pending');
        const gp    = await ctx.safeGasPrice();
        const tx = {
          from: acct.address, to: pointerAddr, data,
          gas: '200000', gasPrice: gp.toString(), nonce: nonce.toString(), chainId,
        };
        const signed = await web3.eth.accounts.signTransaction(tx, key);
        const r = await ctx.sendAndWait(signed.rawTransaction);
        lastTx = r.transactionHash;
      } catch (e) {
        lastErr = e.message || String(e);
        // 'same addr' = already linked correctly — treat as verified.
        if (/same addr/i.test(lastErr)) {
          try { current = await ptr.methods.registry().call(); } catch {}
          return { txHash: lastTx, verified: true, currentRegistry: current, attempts: attempt, lastError: lastErr };
        }
      }
      // Wait one block period, then check pointer.registry()
      await new Promise(r => setTimeout(r, 3000));
      try {
        current = await ptr.methods.registry().call();
      } catch (e) { lastErr = e.message; }
      const isZero = !current || /^0x0+$/.test(String(current).toLowerCase());
      const expected = registryAddr.toLowerCase();
      if (!isZero && String(current).toLowerCase() === expected) {
        return { txHash: lastTx, verified: true, currentRegistry: current, attempts: attempt };
      }
      // Otherwise loop and try again with a fresh nonce.
      log('WARN: proposeRegistry attempt', attempt, 'did not set pointer.registry — currentRegistry =', current || '(read failed)');
    }
    return { txHash: lastTx, verified: false, currentRegistry: current, attempts: 3, lastError: lastErr };
  }

  // ── Public: build artifacts (for frontend deploy via MetaMask if desired)
  app.get('/api/apos/build', (req, res) => {
    try {
      const b = loadBuild();
      res.json({ abi: b.abi, bytecode: b.bytecode, compiledAt: b.compiledAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: registry address + chain id (for MetaMask portals)
  app.get('/api/apos/handshake', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      const cid = await ctx.realChainId();
      res.json({
        chainId: Number(cid),
        chainIdHex: '0x' + Number(cid).toString(16),
        chainName: cfg?.chainName || 'Elyon Chain',
        registry: cfg?.aposRegistry || null,
        rpcUrl: cfg?.publicRpcUrl || (process.env.PUBLIC_RPC_URL || ''),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: current registry state summary (v8 validator/delegator model)
  app.get('/api/apos/info', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const [admin, minVal, valCount, pkgCount, tierCount, adminFees, rewardPool, totalGas, paused] = await Promise.all([
        c.methods.admin().call(),
        c.methods.minValidatorStake().call(),
        c.methods.getValidatorCount().call(),
        c.methods.getPackageCount().call(),
        c.methods.getTierCount().call(),
        c.methods.adminAccumulatedFees().call(),
        c.methods.rewardPool().call(),
        c.methods.totalGasShareBps().call(),
        c.methods.paused().call().catch(() => false),
      ]);
      res.json({
        deployed: true,
        address: cfg.aposRegistry,
        pointerAddress: cfg.aposPointer || null,
        admin,
        minValidatorStakeWei: minVal.toString(),
        validatorCount: Number(valCount),
        packageCount: Number(pkgCount),
        tierCount: Number(tierCount),
        adminAccumulatedFeesWei: adminFees.toString(),
        rewardPoolWei: rewardPool.toString(),
        totalGasShareBps: Number(totalGas),
        paused: !!paused,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // v7.1.0 (audit v7.0.9-I1): hoist _validateKey here so all deploy endpoints
  // (and any future caller) use the same validator. Previously only
  // sendAdminTx/sendNodeTx used it, leaking partial-byte messages on bad
  // keys via direct privateKeyToAccount() in deploy paths.
  function _validateKeyEarly(key) {
    if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw Object.assign(new Error('invalid private key (expected 0x + 64 hex chars)'), { _userError: true });
    }
  }

  // ── Admin: deploy UNPRegistry
  app.post('/api/apos/deploy', requireAuth, async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg) return res.status(400).json({ error: 'No chain configured' });
      const key = req.body?.privateKey || cfg.validatorKey;
      if (!key) return res.status(400).json({ error: 'Admin private key required' });
      const web3 = ctx.web3Ref();
      const b = loadBuild();
      _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
      const account = web3.eth.accounts.privateKeyToAccount(key);
      const contract = new web3.eth.Contract(b.abi);
      const data = contract.deploy({ data: b.bytecode }).encodeABI();
      const cid = await ctx.realChainId();
      const nonce = await web3.eth.getTransactionCount(account.address);
      const gasPrice = await ctx.safeGasPrice();
      const tx = {
        from: account.address, data, gas: '30000000',
        gasPrice: gasPrice.toString(), nonce: nonce.toString(), chainId: cid,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, key);
      const r = await ctx.sendAndWait(signed.rawTransaction);
      let addr = r.contractAddress;
      if (!addr) {
        await new Promise(s => setTimeout(s, 8000));
        const r2 = await web3.eth.getTransactionReceipt(r.transactionHash);
        addr = r2?.contractAddress;
      }
      if (!addr) return res.status(500).json({ error: 'Deploy succeeded but no contract address; tx ' + r.transactionHash });
      const previous = cfg.aposRegistry || null;
      ctx.saveConfig({ ...cfg, aposRegistry: addr, mode: cfg.mode === 'pos-converted' ? 'apos-converted' : (cfg.mode || 'created') });
      log('UNPRegistry deployed at', addr, previous ? '(replaced ' + previous + ')' : '');
      // v7.0 SECURITY: pointer change is timelocked. Calling proposeRegistry
      // schedules the swap; it activates 24h later when applyPendingRegistry()
      // is called (any caller). This protects against instant rug-pull if the
      // admin key is ever compromised. For first-deploy (registry==zero),
      // the existing pending proposal is still active — same flow.
      // v7.11.9 — verify the pointer link took effect, retry on transient
      // failure. For first set (registry==0x0) proposeRegistry commits
      // immediately per APOSPointer.sol; for subsequent changes it goes
      // into the 24h timelock and pointer.registry() stays at the old
      // value until applyPendingRegistry — handled below.
      let pointerProposed = null, pointerError = null, pointerActivatesAt = null;
      let pointerVerified = null, pointerCurrentRegistry = null;
      if (cfg.aposPointer) {
        try {
          const ptr = getPointer(web3, cfg.aposPointer);
          _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
          // Probe whether this is a first-set (registry==0x0) or an update.
          let preRegistry = null;
          try { preRegistry = await ptr.methods.registry().call(); } catch {}
          const isFirstSet = !preRegistry || /^0x0+$/.test(String(preRegistry).toLowerCase());

          if (isFirstSet) {
            // Immediate-commit path — verify & retry until pointer.registry() == addr
            const v = await proposeRegistryAndVerify(web3, cfg.aposPointer, addr, key, cid);
            pointerProposed = v.txHash;
            pointerVerified = v.verified;
            pointerCurrentRegistry = v.currentRegistry;
            if (!v.verified) {
              pointerError = 'proposeRegistry did not link after ' + v.attempts + ' attempts. last currentRegistry=' + v.currentRegistry + ' lastError=' + v.lastError;
              log('ERR:', pointerError);
            } else {
              log('Pointer', cfg.aposPointer, 'LINKED -> registry', addr, '(verified, tx', v.txHash + ')');
            }
          } else {
            // Subsequent change — falls under the 24h timelock; just submit.
            const accountP = web3.eth.accounts.privateKeyToAccount(key);
            const dataP = ptr.methods.proposeRegistry(addr).encodeABI();
            const noncP = await web3.eth.getTransactionCount(accountP.address);
            const gasP  = await ctx.safeGasPrice();
            const txP = {
              from: accountP.address, to: cfg.aposPointer, data: dataP,
              gas: '200000', gasPrice: gasP.toString(), nonce: noncP.toString(), chainId: cid,
            };
            const signedP = await web3.eth.accounts.signTransaction(txP, key);
            const rP = await ctx.sendAndWait(signedP.rawTransaction);
            pointerProposed = rP.transactionHash;
            try {
              const at = await ptr.methods.pendingActivatesAt().call();
              pointerActivatesAt = Number(at);
            } catch {}
            log('Pointer', cfg.aposPointer, 'PROPOSED (timelocked) -> registry', addr,
                'activates at', pointerActivatesAt ? new Date(pointerActivatesAt*1000).toISOString() : '?',
                '(tx', rP.transactionHash + ')');
          }
        } catch (e) {
          pointerError = e.message;
          log('WARN: pointer proposal failed:', e.message);
        }
      }
      // v7.11.11: only report success when the pointer link was either
      // verified post-tx (first-set path) or correctly proposed under the
      // timelock (subsequent rotation). If pointer exists locally AND we
      // tried to link AND verification failed, return success=false so the
      // UI shows red, not green.
      const linkAttemptedHere = !!cfg.aposPointer;
      const firstSetTried     = linkAttemptedHere && !pointerActivatesAt; // immediate-commit path
      const linkOkHere        = !linkAttemptedHere || (firstSetTried ? pointerVerified === true : !!pointerProposed);
      res.json({
        success: linkOkHere,
        error:   linkOkHere ? undefined : ('Registry deployed but pointer auto-link FAILED: ' + (pointerError || 'unknown')),
        address: addr, txHash: r.transactionHash, replacedPrevious: previous,
        pointerAddress: cfg.aposPointer || null,
        pointerProposalTx: pointerProposed,
        pointerActivatesAt,
        pointerActivatesAtIso: pointerActivatesAt ? new Date(pointerActivatesAt*1000).toISOString() : null,
        pointerVerified,
        pointerCurrentRegistry,
        pointerNote: pointerProposed
          ? (pointerActivatesAt
            ? 'Pointer change PROPOSED — apply via /api/apos/apply-pointer after the timelock elapses (' +
              new Date(pointerActivatesAt*1000).toISOString() + ').'
            : (pointerVerified === true
              ? 'Pointer LINKED to registry immediately (first-set, no timelock).'
              : 'Pointer proposeRegistry submitted but verification FAILED — click Re-link in APOS Registry tab.'))
          : null,
        pointerUpdateError: pointerError,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // v7.2.4: re-link an existing pointer to an existing registry without
  // redeploying either. Use when the wizard's deploy step didn't fire the
  // proposeRegistry tx (e.g. ordering issue, transient RPC failure during
  // initial deploy). With v7.1.2+ pointer code, calling proposeRegistry when
  // currentRegistry == 0x0 commits immediately (no timelock). For non-zero
  // currentRegistry the standard 24h timelock applies.
  app.post('/api/apos/repair-pointer', requireAuth, async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposPointer) return res.status(400).json({ error: 'No pointer in config' });
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry in config' });
      const key = req.body?.privateKey || cfg.validatorKey;
      if (!key) return res.status(400).json({ error: 'Admin private key required' });
      const web3 = ctx.web3Ref();
      const ptr = getPointer(web3, cfg.aposPointer);
      _validateKeyEarly(key);
      const account = web3.eth.accounts.privateKeyToAccount(key);
      const cid = await ctx.realChainId();
      const data = ptr.methods.proposeRegistry(cfg.aposRegistry).encodeABI();
      const nonce = await web3.eth.getTransactionCount(account.address);
      const gasPrice = await ctx.safeGasPrice();
      const tx = {
        from: account.address, to: cfg.aposPointer, data,
        gas: '200000', gasPrice: gasPrice.toString(), nonce: nonce.toString(), chainId: cid,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, key);
      const r = await ctx.sendAndWait(signed.rawTransaction);
      let nowRegistry = null;
      try { nowRegistry = await ptr.methods.registry().call(); } catch {}
      log('Pointer', cfg.aposPointer, 'REPAIRED -> registry', cfg.aposRegistry,
          'tx', r.transactionHash, 'currentRegistry now', nowRegistry);
      res.json({ success: true, txHash: r.transactionHash, currentRegistry: nowRegistry });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // v7.0: commit a pending pointer change after the 24h timelock has elapsed.
  // Anyone (no admin auth) can call applyPendingRegistry — the security
  // guarantee is the wall-clock delay, not who triggers the commit.
  app.post('/api/apos/apply-pointer', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposPointer) return res.status(400).json({ error: 'No pointer deployed' });
      // v7.0.3 SECURITY (audit I8): never fall back to validatorKey on a
      // public endpoint — that lets an unauth caller drain the chain admin
      // wallet for gas. Caller must supply their own key.
      const key = req.body?.privateKey;
      if (!key) return res.status(400).json({ error: 'privateKey required to pay gas — pass in body' });
      const web3 = ctx.web3Ref();
      const ptr = getPointer(web3, cfg.aposPointer);
      _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
      const account = web3.eth.accounts.privateKeyToAccount(key);
      const cid = await ctx.realChainId();
      const data = ptr.methods.applyPendingRegistry().encodeABI();
      const nonce = await web3.eth.getTransactionCount(account.address);
      const gasPrice = await ctx.safeGasPrice();
      const tx = {
        from: account.address, to: cfg.aposPointer, data,
        gas: '200000', gasPrice: gasPrice.toString(), nonce: nonce.toString(), chainId: cid,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, key);
      const r = await ctx.sendAndWait(signed.rawTransaction);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // v7.0: cancel a pending pointer proposal (admin only).
  app.post('/api/apos/cancel-pointer-proposal', requireAuth, async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposPointer) return res.status(400).json({ error: 'No pointer deployed' });
      const key = req.body?.privateKey || cfg.validatorKey;
      if (!key) return res.status(400).json({ error: 'admin private key required' });
      const web3 = ctx.web3Ref();
      const ptr = getPointer(web3, cfg.aposPointer);
      _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
      const account = web3.eth.accounts.privateKeyToAccount(key);
      const cid = await ctx.realChainId();
      const data = ptr.methods.cancelPendingRegistry().encodeABI();
      const nonce = await web3.eth.getTransactionCount(account.address);
      const gasPrice = await ctx.safeGasPrice();
      const tx = {
        from: account.address, to: cfg.aposPointer, data,
        gas: '200000', gasPrice: gasPrice.toString(), nonce: nonce.toString(), chainId: cid,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, key);
      const r = await ctx.sendAndWait(signed.rawTransaction);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Discover the chain's canonical APOSPointer.
  //
  //  Algorithm: query all `AdminAssigned(address)` events ever emitted on
  //  this chain where the indexed admin == chain admin (read from the local
  //  registry). The contract that emitted the EARLIEST such event is the
  //  canonical pointer for this chain. Any subsequent pointers deployed by
  //  the same admin (whether by mistake, testing, or malicious intent) are
  //  ignored — there is exactly ONE canonical pointer per chain.
  //
  //  Returns null if no pointer has ever been deployed on this chain.
  async function discoverCanonicalPointer() {
    const cfg = ctx.getConfig();
    if (!cfg?.aposRegistry) return null;
    const web3 = ctx.web3Ref();
    let admin;
    try {
      const reg = getRegistry(web3, cfg.aposRegistry);
      admin = await reg.methods.admin().call();
    } catch (e) {
      // Registry might not exist or be unreadable. Cannot discover yet.
      return null;
    }
    if (!admin || !/^0x[0-9a-fA-F]{40}$/.test(admin)) return null;
    const TOPIC0 = web3.utils.keccak256('AdminAssigned(address)');
    const TOPIC1 = '0x' + admin.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    try {
      const logs = await web3.eth.getPastLogs({
        fromBlock: 0, toBlock: 'latest',
        topics: [TOPIC0, TOPIC1],
      });
      if (!logs || !logs.length) return null;
      logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
      // Verify the emitter has APOSPointer code (defends against an attacker
      // who emits a fake AdminAssigned event from a non-pointer contract).
      const ptrBuild = loadPointerBuild();
      const expectedPrefix = ptrBuild.bytecode.slice(0, 64); // first 32 bytes is enough as a fingerprint
      for (const ev of logs) {
        const code = await web3.eth.getCode(ev.address).catch(() => '');
        if (!code || code === '0x' || code === '0x0') continue;
        // Runtime bytecode != deploy bytecode, so we just check the contract
        // exposes the pointer's expected functions by attempting a static
        // call on `version()`. This is robust against bytecode-format drift.
        try {
          const ptr = getPointer(web3, ev.address);
          await ptr.methods.version().call();
          await ptr.methods.admin().call();
          return ev.address;
        } catch { /* not a pointer; try next */ }
      }
      return null;
    } catch (e) {
      log('discoverCanonicalPointer: getPastLogs failed:', e.message);
      return null;
    }
  }

  // ── Force the local config to use whatever pointer this chain says is
  //    canonical. Idempotent. Returns the pointer address (or null if none
  //    exists yet on the chain).
  async function adoptCanonicalPointer() {
    const cfg = ctx.getConfig();
    const found = await discoverCanonicalPointer();
    if (!found) return { adopted: false, reason: 'no canonical pointer on this chain yet' };
    if (cfg.aposPointer && cfg.aposPointer.toLowerCase() === found.toLowerCase()) {
      return { adopted: true, address: found, alreadySet: true };
    }
    const previous = cfg.aposPointer || null;
    ctx.saveConfig({ ...cfg, aposPointer: found });
    log('Adopted canonical APOS pointer', found, previous ? '(was ' + previous + ')' : '');
    return { adopted: true, address: found, replacedPrevious: previous };
  }

  // Auto-adopt on startup: try once now, then again every 5 minutes as a
  // safety net (in case the pointer hadn't been deployed yet at boot).
  setTimeout(() => adoptCanonicalPointer().catch(() => {}), 5_000);
  setInterval(() => adoptCanonicalPointer().catch(() => {}), 5 * 60_000);

  app.post('/api/apos/discover-pointer', async (req, res) => {
    try {
      const r = await adoptCanonicalPointer();
      if (r.adopted) {
        // Run a sync immediately so the new pointer's registry is also picked up.
        try { await runPointerSync(); } catch {}
      }
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: deploy the APOSPointer contract ONCE per chain. The pointer's
  //    own address is then shared with operator nodes so they can auto-sync
  //    whenever admin redeploys the registry.
  app.post('/api/apos/deploy-pointer', requireAuth, async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg) return res.status(400).json({ error: 'No chain configured' });
      const key = req.body?.privateKey || cfg.validatorKey;
      if (!key) return res.status(400).json({ error: 'Admin private key required' });
      // Refuse if a canonical pointer already exists on the chain. Adopt it
      // instead of letting admin deploy a competing one — every chain has
      // exactly ONE canonical pointer, decided by chain log order.
      const existing = await discoverCanonicalPointer();
      if (existing) {
        const prev = cfg.aposPointer || null;
        ctx.saveConfig({ ...cfg, aposPointer: existing });
        return res.status(400).json({
          error: 'Pointer already exists on this chain at ' + existing + '. Adopting it; do not deploy a new one.',
          adoptedExisting: existing,
          replacedLocal: prev,
        });
      }
      if (cfg.aposPointer) {
        return res.status(400).json({ error: 'Pointer already deployed at ' + cfg.aposPointer + '.' });
      }
      const web3 = ctx.web3Ref();
      const b = loadPointerBuild();
      _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
      const account = web3.eth.accounts.privateKeyToAccount(key);
      const contract = new web3.eth.Contract(b.abi);
      const data = contract.deploy({ data: b.bytecode }).encodeABI();
      const cid = await ctx.realChainId();
      const nonce = await web3.eth.getTransactionCount(account.address);
      const gasPrice = await ctx.safeGasPrice();
      const tx = {
        from: account.address, data, gas: '2000000',
        gasPrice: gasPrice.toString(), nonce: nonce.toString(), chainId: cid,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, key);
      const r = await ctx.sendAndWait(signed.rawTransaction);
      let addr = r.contractAddress;
      if (!addr) {
        await new Promise(s => setTimeout(s, 5000));
        const r2 = await web3.eth.getTransactionReceipt(r.transactionHash);
        addr = r2?.contractAddress;
      }
      if (!addr) return res.status(500).json({ error: 'Pointer deploy succeeded but no address; tx ' + r.transactionHash });
      ctx.saveConfig({ ...cfg, aposPointer: addr });
      log('APOSPointer deployed at', addr);

      // v7.11.11 ORDER FIX (final): the previous v7.2.6 order — propose →
      // bake chainspec → restart — looked correct but lost the proposeRegistry
      // tx whenever it was still un-finalized (in-memory only) at the moment
      // of restart. sendAndWait reported "Receipt found" for the pending-state
      // receipt and proposeRegistryAndVerify saw pointer.registry() == addr in
      // the pre-restart state; but the restart flushed the mempool AND
      // discarded any block that wasn't yet committed to disk, so the post-
      // restart canonical chain didn't contain the tx and pointer.registry
      // stayed 0x0 forever (admin nonce stayed at 3).
      //
      // Correct order is:
      //   (a) bake chainspec
      //   (b) force-restart Nethermind, WAIT for it to be back up
      //   (c) proposeRegistry on the post-restart chain (with verify-and-retry)
      // The chainspec contains aposPointer = addr, so the L2 hook of the
      // post-restart node knows where to look immediately. The proposeRegistry
      // tx lands on a stable, committed chain and is impossible to lose to
      // a subsequent restart.
      try {
        const _path = require('path');
        const _fs   = require('fs');
        const _DATA_DIR = process.env.DATA_DIR || _path.join(__dirname, 'data');
        const specPath = _path.join(_DATA_DIR, 'chainspec.json');
        if (_fs.existsSync(specPath)) {
          const spec = JSON.parse(_fs.readFileSync(specPath, 'utf8'));
          spec.engine = spec.engine || {};
          spec.engine.pos = spec.engine.pos || { params: {} };
          spec.engine.pos.params = spec.engine.pos.params || {};
          spec.engine.pos.params.aposPointer = addr;
          _fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
          log('chainspec.aposPointer baked at', addr, '— restarting Nethermind synchronously');
          if (typeof ctx.restartNode === 'function') {
            await ctx.restartNode({ force: true });
            // Wait for Nethermind RPC to be reachable again before any tx submit.
            const waitDeadline = Date.now() + 90_000;
            const isAlive = ctx.nodeAlive || (async () => true);
            let alive = false;
            while (Date.now() < waitDeadline) {
              try { if (await isAlive()) { alive = true; break; } } catch {}
              await new Promise(r => setTimeout(r, 1500));
            }
            if (!alive) log('WARN: Nethermind did not come back within 90s — proposeRegistry may fail');
            else      log('Nethermind back up after restart — proceeding to proposeRegistry');
          }
        }
      } catch (e) {
        log('WARN: failed to bake aposPointer into chainspec:', e.message);
      }

      // Step (c) — proposeRegistry on the post-restart chain. Skipped when
      // there's no registry yet (user clicked Deploy Pointer first); the
      // /api/apos/deploy path will fire it whenever registry-deploy happens.
      let initialSetTx = null;
      let initialSetVerified = null;
      let initialSetError = null;
      let initialSetCurrent = null;
      if (cfg.aposRegistry) {
        try {
          _validateKeyEarly(key); // v7.1.0 (audit v7.0.9-I1)
          const v = await proposeRegistryAndVerify(web3, addr, cfg.aposRegistry, key, cid);
          initialSetTx = v.txHash;
          initialSetVerified = v.verified;
          initialSetCurrent = v.currentRegistry;
          if (!v.verified) {
            initialSetError = 'proposeRegistry did not link after ' + v.attempts + ' attempts. currentRegistry=' + v.currentRegistry + ' lastError=' + v.lastError;
            log('ERR: pointer auto-link failed —', initialSetError);
          } else {
            log('Pointer', addr, 'LINKED -> registry', cfg.aposRegistry, '(verified, tx', v.txHash + ')');
          }
        } catch (e) {
          initialSetError = e.message;
          log('WARN: initial proposeRegistry failed:', e.message);
        }
      }

      // v7.11.11: success=true ONLY when verification passed (or no registry
      // to link yet). If aposRegistry was set and the auto-link couldn't be
      // confirmed, return success:false with an explicit error so the UI
      // shows red, not green. The user can still call /api/apos/repair-pointer
      // afterwards to recover, but at least they know something is wrong.
      const linkAttempted = !!cfg.aposRegistry;
      const linkOk        = !linkAttempted || initialSetVerified === true;
      res.json({
        success: linkOk,
        error:   linkOk ? undefined : ('Pointer deployed but auto-link to registry FAILED: ' + (initialSetError || 'unknown')),
        address: addr,
        txHash: r.transactionHash,
        initialSetTx,
        initialSetVerified,
        initialSetCurrent,
        initialSetError,
        pointerNote: linkAttempted
          ? (linkOk
            ? 'Pointer deployed AND LINKED to registry ' + cfg.aposRegistry + ' (verified on-chain).'
            : 'Pointer deployed but auto-link verification FAILED — click Re-link in APOS Registry tab.')
          : 'Pointer deployed. Deploy a Registry next; it will auto-link.',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Read pointer state. Anyone can call. Returns whether pointer is
  //    deployed locally (cfg-known) and its current on-chain registry value.
  app.get('/api/apos/pointer-info', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposPointer) return res.json({ deployed: false });
      const web3 = ctx.web3Ref();
      const ptr = getPointer(web3, cfg.aposPointer);
      const [currentRegistry, version, changedAt, admin] = await Promise.all([
        ptr.methods.registry().call().catch(() => '0x0000000000000000000000000000000000000000'),
        ptr.methods.version().call().catch(() => '0'),
        ptr.methods.lastChangedAt().call().catch(() => '0'),
        ptr.methods.admin().call().catch(() => null),
      ]);
      res.json({
        deployed: true,
        address: cfg.aposPointer,
        currentRegistry,
        version: Number(version),
        lastChangedAt: Number(changedAt),
        admin,
        localRegistry: cfg.aposRegistry || null,
        inSync: cfg.aposRegistry && currentRegistry &&
                cfg.aposRegistry.toLowerCase() === String(currentRegistry).toLowerCase(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Configure this dashboard to track a pointer deployed elsewhere.
  //    Body: { pointerAddress }. Validates the address has code (so you can't
  //    point at an empty slot or wallet by accident). Actual sync happens
  //    on the next worker tick.
  app.post('/api/apos/use-pointer', requireAuth, async (req, res) => {
    try {
      const { pointerAddress } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg) return res.status(400).json({ error: 'No chain configured' });
      const addr = String(pointerAddress || '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ error: 'invalid pointer address' });
      const web3 = ctx.web3Ref();
      const code = await web3.eth.getCode(addr);
      if (!code || code === '0x' || code === '0x0') return res.status(400).json({ error: 'no contract code at ' + addr });
      ctx.saveConfig({ ...cfg, aposPointer: addr });
      log('APOS pointer set to', addr, '— next sync tick will read the registry from it');
      // Try to sync immediately so the user sees the result without waiting.
      try { await runPointerSync(); } catch {}
      res.json({ success: true, pointerAddress: addr });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Periodic poll of the pointer; if its registry differs from our cached
  // aposRegistry, repoint atomically. Runs every 60s after any pointer is
  // configured. Also exposed manually so the UI can force a sync.
  async function runPointerSync() {
    const cfg = ctx.getConfig();
    if (!cfg?.aposPointer) return { skipped: true, reason: 'no pointer configured' };
    const web3 = ctx.web3Ref();
    const ptr = getPointer(web3, cfg.aposPointer);
    let onChain;
    try { onChain = await ptr.methods.registry().call(); }
    catch (e) { return { skipped: true, reason: 'pointer read failed: ' + e.message }; }
    if (!onChain || onChain === '0x0000000000000000000000000000000000000000') {
      return { skipped: true, reason: 'pointer holds zero address (admin has not set it yet)' };
    }
    if (cfg.aposRegistry && onChain.toLowerCase() === cfg.aposRegistry.toLowerCase()) {
      return { skipped: true, inSync: true };
    }
    // Verify the new target has contract code on this chain.
    const code = await web3.eth.getCode(onChain);
    if (!code || code === '0x') return { skipped: true, reason: 'pointer target has no code yet' };
    const previous = cfg.aposRegistry || null;
    ctx.saveConfig({ ...cfg, aposRegistry: onChain });
    log('Pointer sync: registry', previous, '->', onChain);
    return { synced: true, previous, current: onChain };
  }
  app.post('/api/apos/sync-from-pointer', async (req, res) => {
    try { res.json(await runPointerSync()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Schedule a recurring poll. 60s is a sensible default — gives operators
  // ~1 minute lag after admin redeploys.
  setInterval(() => { runPointerSync().catch(() => {}); }, 60_000);

  // ── Public: APOSPointer build (ABI + bytecode) for clients that want to
  //    deploy/interact via MetaMask client-side.
  app.get('/api/apos/pointer-build', (req, res) => {
    try {
      const b = loadPointerBuild();
      res.json({ abi: b.abi, bytecode: b.bytecode, compiledAt: b.compiledAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Sync the local config's registry address to a different one. Two modes:
  //    1. { registryAddress: "0x..." } — set directly
  //    2. { adminUrl: "http://admin-host:3000" } — fetch /api/apos/info from
  //       that URL and adopt its address. Used by operators after the admin
  //       redeploys: paste admin URL once, the dashboard repoints itself.
  //    The new address is sanity-checked: must look like a 0x-20-byte hex AND
  //    the on-chain code at that address must be non-empty (so we don't point
  //    the dashboard at a wallet or empty slot by accident).
  app.post('/api/apos/sync-registry', requireAuth, async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg) return res.status(400).json({ error: 'No chain configured' });
      const { registryAddress, adminUrl } = req.body || {};
      let newAddr = (registryAddress || '').trim();
      if (!newAddr && adminUrl) {
        // v7.0.3 SECURITY (audit I9): block SSRF to internal services.
        if (typeof ctx.validateExternalUrl === 'function') {
          try { ctx.validateExternalUrl(adminUrl); }
          catch (e) { return res.status(400).json({ error: 'adminUrl rejected: ' + e.message }); }
        }
        // Fetch the admin's /api/apos/info; tolerate trailing slash.
        const u = String(adminUrl).replace(/\/+$/, '') + '/api/apos/info';
        const r = await fetch(u);
        if (!r.ok) return res.status(400).json({ error: 'admin URL returned HTTP ' + r.status });
        const info = await r.json();
        if (!info || !info.deployed || !info.address)
          return res.status(400).json({ error: 'admin reports no registry deployed' });
        newAddr = info.address;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(newAddr))
        return res.status(400).json({ error: 'invalid or missing registry address' });
      // Verify there's actually code at that address on this chain.
      const web3 = ctx.web3Ref();
      const code = await web3.eth.getCode(newAddr);
      if (!code || code === '0x' || code === '0x0')
        return res.status(400).json({ error: 'no contract code at ' + newAddr + ' on this chain' });
      const previous = cfg.aposRegistry || null;
      ctx.saveConfig({ ...cfg, aposRegistry: newAddr });
      log('APOS registry synced to', newAddr, previous ? '(was ' + previous + ')' : '');
      res.json({ success: true, address: newAddr, replacedPrevious: previous });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── List packages
  app.get('/api/apos/packages', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json([]);
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const count = Number(await c.methods.getPackageCount().call());
      const out = [];
      for (let i = 0; i < count; i++) {
        const id = await c.methods.packageIds(i).call();
        const p = await c.methods.packages(id).call();
        out.push({
          id: Number(p.id), name: p.name,
          minAmountWei: p.minAmount.toString(),
          lockSeconds: Number(p.lockSeconds),
          aprBps: Number(p.aprBps),
          active: p.active,
          allowEarlyWithdraw: !!p.allowEarlyWithdraw,
        });
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic: send a signed admin transaction (helper)
  // v7.0.8 (audit M7): centralized private key validation. The web3 lib
  // throws InvalidPrivateKeyError with a partial-byte message that bubbles
  // up to the caller via res.status(500).json({error: e.message}); we
  // pre-validate so the user gets a clean 400 instead of a leaky 500.
  function _validateKey(key) {
    if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw Object.assign(new Error('invalid private key (expected 0x + 64 hex chars)'), { _userError: true });
    }
  }
  async function sendAdminTx(method, valueWei, key) {
    _validateKey(key);
    const web3 = ctx.web3Ref();
    const cfg = ctx.getConfig();
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const cid = await ctx.realChainId();
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await ctx.safeGasPrice();
    const tx = {
      from: account.address, to: cfg.aposRegistry,
      data: method.encodeABI(), value: String(valueWei || 0),
      gas: '500000', gasPrice: gasPrice.toString(),
      nonce: nonce.toString(), chainId: cid,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    return ctx.sendAndWait(signed.rawTransaction);
  }

  // ── Admin: add staking package. Body now includes allowEarlyWithdraw —
  //    default false (= traditional time-locked). When true, users can pull
  //    principal before unlock at the cost of forfeiting accrued APR.
  app.post('/api/apos/admin/add-package', requireAuth, async (req, res) => {
    try {
      const { name, minAmountEther, lockDays, aprBps, allowEarlyWithdraw, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const r = await sendAdminTx(
        c.methods.addPackage(
          String(name || 'Custom'),
          web3.utils.toWei(String(minAmountEther||100), 'ether'),
          parseInt(lockDays||30) * 86400,
          parseInt(aprBps||500),
          !!allowEarlyWithdraw
        ), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: withdraw admin pool
  app.post('/api/apos/admin/withdraw-admin-fees', requireAuth, async (req, res) => {
    try {
      const { to, amountEther, privateKey } = req.body || {};
      // v7.0.8 (audit M6): validate `to` address format before forwarding.
      if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) return res.status(400).json({ error: 'invalid recipient address (expected 0x + 40 hex)' });
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const r = await sendAdminTx(
        c.methods.withdrawAdminFees(to, web3.utils.toWei(String(amountEther||0), 'ether')),
        0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PK helper: derive the wallet address from a private key, server-side.
  //
  //  Used by the operator portal "Set Key" button so the dashboard can show
  //  PK-mode users their wallet address even when client-side libs (ethers,
  //  Web3) aren't yet loaded. The server forgets the key immediately; only
  //  the public address is returned. Never logged.
  app.post('/api/apos/pk/derive', async (req, res) => {
    try {
      const pk = (req.body || {}).privateKey || '';
      const clean = String(pk).replace(/^0x/i, '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(clean))
        return res.status(400).json({ error: 'private key must be 64 hex characters (with or without 0x prefix)' });
      const web3 = ctx.web3Ref();
      const acct = web3.eth.accounts.privateKeyToAccount('0x' + clean);
      res.json({ success: true, address: acct.address });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Public: gas-fee info — DEFAULT Ethereum (EIP-1559). Reports the live
  //    base fee so panels can show network pricing; there is no custom
  //    fee policy contract-side any more.
  app.get('/api/apos/fee-policy', async (req, res) => {
    try {
      const web3 = ctx.web3Ref();
      const blk = await web3.eth.getBlock('latest');
      const gp = await web3.eth.getGasPrice().catch(() => '0');
      res.json({
        deployed: true,
        model: 'eip1559',
        baseFeePerGasWei: (blk?.baseFeePerGas ?? 0).toString(),
        suggestedGasPriceWei: gp.toString(),
        note: 'Gas pricing is the default Ethereum EIP-1559 market (base fee burned, priority tip collected). Fee SHARING is governed by the APOS registry tiers.',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: APOS chain mode (informational)
  app.get('/api/apos/mode', (req, res) => {
    const cfg = ctx.getConfig();
    res.json({
      mode: cfg?.mode || 'none',
      hasRegistry: !!cfg?.aposRegistry,
      registry: cfg?.aposRegistry || null,
    });
  });

  // ── Signed user transaction helper (operator/validator/delegator keys).
  async function sendNodeTx(method, valueWei, key) {
    _validateKey(key); // v7.0.8 (audit M7)
    const web3 = ctx.web3Ref();
    const cfg = ctx.getConfig();
    const account = web3.eth.accounts.privateKeyToAccount(key);
    const cid = await ctx.realChainId();
    const nonce = await web3.eth.getTransactionCount(account.address);
    const gasPrice = await ctx.safeGasPrice();
    const tx = {
      from: account.address, to: cfg.aposRegistry,
      data: method.encodeABI(), value: String(valueWei || 0),
      gas: '700000', gasPrice: gasPrice.toString(),
      nonce: nonce.toString(), chainId: cid,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, key);
    return ctx.sendAndWait(signed.rawTransaction);
  }

  // ═══════════════════════════════════════════════════════════════
  // v9 — VALIDATOR / DELEGATOR model. ONE POOL per validator:
  //   POOL = selfStake + delegatedTotal — the tier curve (gasShareBps) AND
  //   the BELOW_MIN rule read this single number. Delegator deposits raise
  //   the tier directly; there is no stake-vs-pool split any more.
  //   Validator: one package at a time (top-up = same package; switching
  //   requires the term to end). Package APR accrues DAILY on selfStake and
  //   is claimable any time (claim-profit). The validator publishes an
  //   on-chain delegator rate (bps, capped at the package APR).
  //   TWO-TIER marketing model: each validator publishes its own TIER-2
  //   packages (addValidatorPackage — ANNUAL rateBps capped at the tier-1
  //   package APR, lock term, min deposit, early-exit penalty <= 20%) and
  //   a public profile. Delegators join a specific package (delegate /
  //   delegateByCode with vpkgIdx): every deposit is a NEW POSITION
  //   snapshotting the package's rate + lock + penalty (grandfathered).
  //   Delegators self-withdraw (withdraw-position): principal + accrued
  //   profit; exiting before since+lockSeconds pays the position's
  //   penaltyBps (kept by the validator).
  // ═══════════════════════════════════════════════════════════════

  // BELOW_MIN (=5): approved validator whose STAKE dropped under the network
  // minimum — auto-removed from earning until the stake is refilled.
  const VAL_STATUS = ['NONE', 'PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'BELOW_MIN'];

  // ── TWO-TIER helpers ──
  // Read a validator's published tier-2 packages. rateBps is ANNUAL (same
  // unit as the tier-1 package aprBps) — UIs display monthlyPct = bps/1200.
  async function readVPackages(c, addr) {
    const count = Number(await c.methods.getValidatorPackageCount(addr).call().catch(() => 0));
    const out = [];
    for (let i = 0; i < count && i < 256; i++) {
      try {
        const p = await c.methods.validatorPackages(addr, i).call();
        out.push({
          idx: i,
          id: Number(p.id),
          name: p.name,
          lockSeconds: Number(p.lockSeconds),
          lockDays: Math.round(Number(p.lockSeconds) / 86400),
          minAmountWei: p.minAmountWei.toString(),
          minEln: Number(BigInt(p.minAmountWei.toString()) / 1000000000000n) / 1e6,
          rateBpsAnnual: Number(p.rateBps),
          annualPct: Number(p.rateBps) / 100,
          monthlyPct: Math.round((Number(p.rateBps) / 1200) * 10000) / 10000,
          penaltyBps: Number(p.penaltyBps),
          penaltyPct: Number(p.penaltyBps) / 100,
          active: !!p.active,
        });
      } catch {}
    }
    return out;
  }
  // Parse-safe profile JSON ({company, contact, address, website, about}).
  function parseProfile(raw) {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch { return null; }
  }
  // Resolve ":validator" route params that may be an address OR an APOS code.
  async function resolveValidatorParam(c, param) {
    const s = String(param || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
    const addr = await c.methods.codeToValidator(s).call().catch(() => null);
    if (addr && !/^0x0+$/.test(String(addr).toLowerCase())) return addr;
    return null;
  }

  async function readValidator(c, addr) {
    const v = await c.methods.getValidatorInfo(addr).call();
    const selfStake = BigInt(v.selfStake.toString());
    const delegated = BigInt(v.delegatedTotal.toString());
    let delegatorCount = 0, offer = '', rateBps = 0, accrued = 0n, profile = '', vpackageCount = 0;
    try { delegatorCount = Number(await c.methods.getDelegatorCount(addr).call()); } catch {}
    try { offer = await c.methods.validatorOffer(addr).call(); } catch {}
    try { rateBps = Number(await c.methods.delegatorRateBps(addr).call()); } catch {}
    try { accrued = BigInt((await c.methods.pendingValidatorProfit(addr).call()).toString()); } catch {}
    try { profile = await c.methods.validatorProfile(addr).call(); } catch {}
    try { vpackageCount = Number(await c.methods.getValidatorPackageCount(addr).call()); } catch {}
    return {
      address: addr,
      status: Number(v.status),
      statusLabel: VAL_STATUS[Number(v.status)] || 'NONE',
      code: v.code || '',
      // v9 ONE POOL: tier + BELOW_MIN read selfStake + delegatedTotal.
      poolWei: (selfStake + delegated).toString(),
      stakeWei: selfStake.toString(),          // validator's own package-locked part
      selfStakeWei: selfStake.toString(),      // compat alias of stakeWei
      delegatedTotalWei: delegated.toString(), // delegators' part of the pool
      selectedPackageId: Number(v.selectedPackageId),
      gasShareBps: Number(v.gasShareBps),
      aprBps: Number(v.aprBps),
      accumulatedFeesWei: v.accumulatedFees.toString(),
      delegatorRateBps: rateBps,               // on-chain rate paid to NEW positions
      accruedProfitWei: accrued.toString(),    // daily package-APR profit, claimable
      delegatorCount,
      offer,
      profile,                                 // raw JSON string (validator page)
      profileData: parseProfile(profile),      // parse-safe {company, contact, address, website, about}
      vpackageCount,                           // published tier-2 packages (see /api/apos/vpackages/:validator)
    };
  }

  // ── Public: list all validators (the public site + panels read this).
  app.get('/api/apos/validators', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, validators: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const count = Number(await c.methods.getValidatorCount().call());
      const out = [];
      for (let i = 0; i < count && i < 1024; i++) {
        const addr = await c.methods.validatorList(i).call();
        if (addr === '0x0000000000000000000000000000000000000000') continue;
        out.push(await readValidator(c, addr));
      }
      // ?approved=1 → only ACTIVE validators (public site list)
      const onlyApproved = String(req.query.approved || '') === '1';
      res.json({ deployed: true, validators: onlyApproved ? out.filter(v => v.status === 2) : out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: one validator's detail (incl. profile + tier-2 packages).
  app.get('/api/apos/validator/:address', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const v = await readValidator(c, req.params.address);
      const minStake = await c.methods.minValidatorStake().call();
      const vpackages = await readVPackages(c, req.params.address);
      res.json({ deployed: true, ...v, vpackages, minValidatorStakeWei: minStake.toString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: a validator's published TIER-2 packages. :validator may be a
  //    0x address OR the public APOS code (the validator page passes either).
  app.get('/api/apos/vpackages/:validator', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, vpackages: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const addr = await resolveValidatorParam(c, req.params.validator);
      if (!addr) return res.status(404).json({ error: 'validator not found' });
      const vpackages = await readVPackages(c, addr);
      res.json({ deployed: true, validator: addr, vpackages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: resolve a validator by its APOS code (delegator portal).
  app.get('/api/apos/validator-by-code/:code', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const addr = await c.methods.codeToValidator(String(req.params.code)).call();
      if (!addr || /^0x0+$/.test(addr.toLowerCase())) {
        return res.status(404).json({ error: 'No validator with code "' + req.params.code + '"' });
      }
      const v = await readValidator(c, addr);
      const vpackages = await readVPackages(c, addr);
      res.json({ deployed: true, ...v, vpackages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // v9 — read one position + its live accrual/penalty info. Two-tier model:
  // each position carries its snapshotted VPackage terms (vpkgId,
  // lockSeconds, penaltyBps) — the early-exit rule is per-position now.
  async function readPosition(c, op, i) {
    const d = await c.methods.delegations(op, i).call();
    const lockSeconds = Number(d.lockSeconds || 0);
    let accrued = '0', earlyUntil = Number(d.since) + lockSeconds;
    try {
      const pp = await c.methods.positionProfit(op, i).call();
      accrued = pp.accrued.toString();
      earlyUntil = Number(pp.earlyUntil);
    } catch {}
    let label = '';
    try { label = await c.methods.delegatorLabel(op, d.delegator).call(); } catch {}
    // Look up the package the position was opened in (id is 1-based index).
    const vpkgId = Number(d.vpkgId || 0);
    let vpkgName = '';
    if (vpkgId > 0) {
      try { vpkgName = (await c.methods.validatorPackages(op, vpkgId - 1).call()).name; } catch {}
    }
    return {
      posIdx: i,
      delegator: d.delegator,
      amountWei: d.amount.toString(),
      rateBps: Number(d.rateBps),            // GRANDFATHERED ANNUAL rate of this position
      monthlyPct: Math.round((Number(d.rateBps) / 1200) * 10000) / 10000,
      since: Number(d.since),
      withdrawnWei: d.withdrawn.toString(),
      label: label || d.label || '',
      accruedWei: accrued,                   // unpaid profit on remaining principal
      earlyUntil,                            // unlockAt: before this ts a self-withdraw pays penaltyBps
      unlockAt: earlyUntil,                  // alias (clearer name for the panels)
      // ── two-tier snapshot (grandfathered package terms) ──
      vpkgId,
      vpkgIdx: vpkgId > 0 ? vpkgId - 1 : null,
      vpkgName,
      lockSeconds,
      lockDays: Math.round(lockSeconds / 86400),
      penaltyBps: Number(d.penaltyBps || 0),
      penaltyPct: Number(d.penaltyBps || 0) / 100,
    };
  }

  // ── Public: a validator's delegation POSITIONS (the validator panel table).
  //    Each deposit is its own position with a grandfathered rate.
  app.get('/api/apos/delegators/:validator', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, positions: [], delegators: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const op = req.params.validator;
      const count = Number(await c.methods.getDelegatorCount(op).call());
      const out = [];
      for (let i = 0; i < count && i < 4096; i++) {
        const p = await readPosition(c, op, i);
        if (p.amountWei === '0' && p.withdrawnWei === '0') continue;
        out.push(p);
      }
      // `delegators` kept as a compat alias of `positions`.
      res.json({ deployed: true, positions: out, delegators: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: every position THIS wallet holds (delegator portal).
  app.get('/api/apos/my-delegations/:address', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, delegations: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const me = String(req.params.address).toLowerCase();
      const count = Number(await c.methods.getValidatorCount().call());
      const out = [];
      for (let i = 0; i < count && i < 1024; i++) {
        const op = await c.methods.validatorList(i).call();
        if (op === '0x0000000000000000000000000000000000000000') continue;
        const n = Number(await c.methods.getDelegatorCount(op).call().catch(() => 0));
        if (!n) continue;
        let v = null;
        for (let j = 0; j < n && j < 4096; j++) {
          const p = await readPosition(c, op, j);
          if (String(p.delegator).toLowerCase() !== me) continue;
          if (p.amountWei === '0' && p.withdrawnWei === '0') continue;
          if (!v) v = await c.methods.getValidatorInfo(op).call();
          let gifts = '0';
          try { gifts = (await c.methods.distributedTotal(op, p.delegator).call()).toString(); } catch {}
          out.push({
            validator: op,
            code: v.code || '',
            ...p,
            totalDistributedWei: gifts,
          });
        }
      }
      res.json({ deployed: true, delegations: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: ONE-PACKAGE-PER-DELEGATOR status of a wallet. The portals call
  //    this after wallet connect to know whether (and where) the wallet
  //    already has an active package — and disable mismatching Join buttons.
  //    → { activeValidator, activeValidatorCode, activeVpkgIdx, activeVpkgName,
  //        outstandingWei } (nulls / "0" when the wallet has no active package).
  app.get('/api/apos/delegator-status/:address', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, activeValidator: null, activeValidatorCode: null, activeVpkgIdx: null, outstandingWei: '0' });
      const addr = String(req.params.address || '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ error: 'invalid address' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      let curVal = null, outstanding = '0';
      try { curVal = await c.methods.delegatorActiveValidator(addr).call(); } catch {}
      try { outstanding = (await c.methods.delegatorOutstandingWei(addr).call()).toString(); } catch {}
      if (!curVal || /^0x0+$/.test(String(curVal).toLowerCase())) {
        return res.json({ deployed: true, activeValidator: null, activeValidatorCode: null, activeVpkgIdx: null, activeVpkgName: null, outstandingWei: '0' });
      }
      const idxPlus1 = Number(await c.methods.delegatorActiveVpkgIdxPlus1(addr).call().catch(() => 0));
      const activeVpkgIdx = idxPlus1 > 0 ? idxPlus1 - 1 : null;
      let code = null, vpkgName = null;
      try { code = (await c.methods.getValidatorInfo(curVal).call()).code || null; } catch {}
      if (activeVpkgIdx !== null) {
        try { vpkgName = (await c.methods.validatorPackages(curVal, activeVpkgIdx).call()).name || null; } catch {}
      }
      res.json({
        deployed: true,
        activeValidator: curVal,
        activeValidatorCode: code,
        activeVpkgIdx,
        activeVpkgName: vpkgName,
        outstandingWei: outstanding,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Public: the admin tier curve (STAKE volume → APR + gas share).
  //    minPoolWei is the legacy field name — thresholds apply to the
  //    validator's package-locked STAKE only, not the liquid pool.
  app.get('/api/apos/tiers', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, tiers: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const count = Number(await c.methods.getTierCount().call());
      const tiers = [];
      for (let i = 0; i < count; i++) {
        const t = await c.methods.tiers(i).call();
        tiers.push({
          minPoolWei: t.minPoolWei.toString(),
          aprBps: Number(t.aprBps),
          gasShareBps: Number(t.gasShareBps),
        });
      }
      res.json({ deployed: true, tiers });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: set the full tier curve at once.
  //    Body: { tiers: [{ minPoolEther, aprBps, gasShareBps }, ...], privateKey? }
  app.post('/api/apos/admin/set-tiers', requireAuth, async (req, res) => {
    try {
      const { tiers, privateKey } = req.body || {};
      if (!Array.isArray(tiers) || !tiers.length) return res.status(400).json({ error: 'tiers array required' });
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const minPool = [], apr = [], gas = [];
      for (const t of tiers) {
        minPool.push(web3.utils.toWei(String(t.minPoolEther ?? 0), 'ether'));
        apr.push(parseInt(t.aprBps || 0));
        gas.push(parseInt(t.gasShareBps || 0));
      }
      const r = await sendAdminTx(c.methods.setTiers(minPool, apr, gas), 0, key);
      res.json({ success: true, txHash: r.transactionHash, count: tiers.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: approve a validator + issue its unique public APOS code.
  app.post('/api/apos/admin/approve-validator', requireAuth, async (req, res) => {
    try {
      const { address, code, privateKey } = req.body || {};
      if (!address || !code) return res.status(400).json({ error: 'address + code required' });
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.approveValidator(address, String(code)), 0, key);
      res.json({ success: true, txHash: r.transactionHash, code: String(code) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/apos/admin/reject-validator', requireAuth, async (req, res) => {
    try {
      const { address, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.rejectValidator(address), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/apos/admin/suspend-validator', requireAuth, async (req, res) => {
    try {
      const { address, reason, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.suspendValidator(address, String(reason || '')), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/apos/admin/set-validator-code', requireAuth, async (req, res) => {
    try {
      const { address, code, privateKey } = req.body || {};
      if (!address || !code) return res.status(400).json({ error: 'address + code required' });
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.setValidatorCode(address, String(code)), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: re-evaluate a validator's tier after editing the curve.
  app.post('/api/apos/admin/refresh-tier', requireAuth, async (req, res) => {
    try {
      const { address, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.refreshTier(address), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: set minimum validator self-stake.
  app.post('/api/apos/admin/set-min-stake', requireAuth, async (req, res) => {
    try {
      const { minValidatorEther, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const r = await sendAdminTx(
        c.methods.setMinValidatorStake(web3.utils.toWei(String(minValidatorEther || 10), 'ether')), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: enable/disable a staking package.
  app.post('/api/apos/admin/set-package-active', requireAuth, async (req, res) => {
    try {
      const { id, active, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.setPackageActive(parseInt(id), !!active), 0, key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: fund the reward pool that pays validator package APR.
  app.post('/api/apos/admin/fund-reward-pool', requireAuth, async (req, res) => {
    try {
      const { amountEther, privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      const key = privateKey || cfg.validatorKey;
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const r = await sendAdminTx(c.methods.fundRewardPool(),
        web3.utils.toWei(String(amountEther || 0), 'ether'), key);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: apply THROUGH a staking package (stake >= max(minValidatorStake,
  //    package.minAmount); the package is selected + the stake locked at apply
  //    time; admin approval follows).
  //    Body: { privateKey, packageId, stakeEther?, pubKey? }
  app.post('/api/apos/validator/apply', async (req, res) => {
    try {
      const { privateKey, stakeEther, pubKey, packageId } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      if (packageId === undefined || packageId === null || packageId === '')
        return res.status(400).json({ error: 'packageId required — applying now stakes through an admin package' });
      const pkgId = parseInt(packageId);
      if (!Number.isFinite(pkgId) || pkgId <= 0) return res.status(400).json({ error: 'invalid packageId' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      // Validate against the on-chain package list before signing anything.
      const p = await c.methods.packages(pkgId).call();
      if (!p || Number(p.id) === 0) return res.status(400).json({ error: 'package ' + pkgId + ' does not exist' });
      if (!p.active) return res.status(400).json({ error: 'package ' + pkgId + ' is not active' });
      const minStakeWei = BigInt((await c.methods.minValidatorStake().call()).toString());
      const pkgMinWei   = BigInt(p.minAmount.toString());
      const floorWei    = minStakeWei > pkgMinWei ? minStakeWei : pkgMinWei;
      let stakeWei;
      if (stakeEther !== undefined && stakeEther !== null && stakeEther !== '') {
        stakeWei = web3.utils.toWei(String(stakeEther), 'ether');
        if (BigInt(stakeWei) < floorWei) {
          return res.status(400).json({
            error: 'stake too low: need at least ' + (Number(floorWei) / 1e18) +
                   ' ELN (max of min validator stake and the package minimum)',
          });
        }
      } else {
        // Default = max(minValidatorStake, package.minAmount).
        stakeWei = floorWei.toString();
      }
      const r = await sendNodeTx(c.methods.applyAsValidator(pubKey || '0x', pkgId), stakeWei, privateKey);
      res.json({ success: true, txHash: r.transactionHash, stakeWei, packageId: pkgId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator (ACTIVE or BELOW_MIN — staking again is how a below-min
  //    validator recovers): TOP UP the SAME selected package with wallet
  //    principal (re-locks the same term). One package at a time — switching
  //    requires the current term to end (select-package).
  //    Body: { privateKey, packageId, amountEther }
  app.post('/api/apos/validator/stake-package', async (req, res) => {
    try {
      const { privateKey, packageId, amountEther } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      if (packageId === undefined || packageId === null || packageId === '')
        return res.status(400).json({ error: 'packageId required' });
      if (amountEther === undefined || amountEther === null || amountEther === '')
        return res.status(400).json({ error: 'amountEther required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const valueWei = BigInt(web3.utils.toWei(String(amountEther), 'ether'));
      // Pre-flight: the contract only allows topping up the SAME selected
      // package — give a clean 400 instead of a revert.
      {
        const acctT = web3.eth.accounts.privateKeyToAccount(privateKey);
        const infoT = await c.methods.getValidatorInfo(acctT.address).call().catch(() => null);
        const sel = infoT ? Number(infoT.selectedPackageId) : 0;
        if (sel && sel !== parseInt(packageId)) {
          return res.status(400).json({
            error: 'top-up must use your selected package (#' + sel + '). To change packages, wait for the term to end and use select-package.',
            selectedPackageId: sel,
          });
        }
      }
      // Pre-flight balance check (mempool silently drops under-funded txs).
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      const balanceWei = BigInt(await web3.eth.getBalance(acct.address));
      const gasPrice   = BigInt(await ctx.safeGasPrice());
      const needed     = valueWei + gasPrice * 700000n;
      if (balanceWei < needed) {
        return res.status(400).json({
          error: `Insufficient balance: wallet ${acct.address} has ${(Number(balanceWei)/1e18).toFixed(6)} ELN but needs ${(Number(needed)/1e18).toFixed(6)} ELN (stake + gas).`,
          walletAddress: acct.address,
        });
      }
      const r = await sendNodeTx(c.methods.validatorStakeInPackage(parseInt(packageId)), valueWei.toString(), privateKey);
      res.json({ success: true, txHash: r.transactionHash, valueWei: valueWei.toString(), packageId: parseInt(packageId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: SET DELEGATOR RATE — publish the on-chain APR paid to NEW
  //    delegator positions. Capped at the selected package's APR; existing
  //    positions keep their deposit-time rate (grandfathered).
  //    Body: { privateKey, ratePct | rateBps }
  app.post('/api/apos/validator/set-rate', async (req, res) => {
    try {
      const { privateKey, ratePct, rateBps } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      let bps;
      if (rateBps !== undefined && rateBps !== null && rateBps !== '') bps = Math.round(Number(rateBps));
      else if (ratePct !== undefined && ratePct !== null && ratePct !== '') bps = Math.round(Number(ratePct) * 100);
      else return res.status(400).json({ error: 'ratePct (e.g. 6.5) or rateBps required' });
      if (!Number.isFinite(bps) || bps < 0) return res.status(400).json({ error: 'invalid rate' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      // Pre-flight: the contract caps the rate at the selected package's APR —
      // check here too for a clean 400 instead of a revert.
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      const info = await c.methods.getValidatorInfo(acct.address).call().catch(() => null);
      if (info) {
        const pkgId = Number(info.selectedPackageId);
        if (!pkgId) return res.status(400).json({ error: 'no package selected — stake into a package first' });
        const p = await c.methods.packages(pkgId).call().catch(() => null);
        if (p && bps > Number(p.aprBps)) {
          return res.status(400).json({
            error: 'rate exceeds your package APR cap: max ' + (Number(p.aprBps) / 100) + '% (' + p.aprBps + ' bps)',
            maxRateBps: Number(p.aprBps),
          });
        }
      }
      const r = await sendNodeTx(c.methods.setDelegatorRate(bps), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, rateBps: bps });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══ TWO-TIER: validator-published packages + public profile ═══════
  // ── Validator: ADD a tier-2 delegation package.
  //    Body: { privateKey, name, lockDays, minEln (legacy alias: maxEln), ratePctMonthly | rateBpsAnnual, penaltyPct }
  //    The rate is stored ON-CHAIN as ANNUAL bps (same unit as the tier-1
  //    package aprBps so accrual math is consistent): annual bps =
  //    monthly% × 12 × 100. Capped at the validator's tier-1 package APR.
  app.post('/api/apos/validator/add-package', async (req, res) => {
    try {
      const { privateKey, name, lockDays, minEln, maxEln, ratePctMonthly, rateBpsAnnual, penaltyPct } = req.body || {};
      // minEln = minimum deposit per position; legacy clients sent maxEln.
      const minDepositEln = (minEln !== undefined && minEln !== null && minEln !== '') ? minEln : maxEln;
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const pkgName = String(name || '').trim();
      if (!pkgName || pkgName.length > 64) return res.status(400).json({ error: 'name required (max 64 chars)' });
      const days = Number(lockDays);
      if (!Number.isFinite(days) || days < 0) return res.status(400).json({ error: 'lockDays required (0 = no lock)' });
      if (!minDepositEln || Number(minDepositEln) <= 0) return res.status(400).json({ error: 'minEln > 0 required (min deposit per position)' });
      // Rate: monthly % is the marketing unit; on-chain we store ANNUAL bps.
      let bps;
      if (rateBpsAnnual !== undefined && rateBpsAnnual !== null && rateBpsAnnual !== '') {
        bps = Math.round(Number(rateBpsAnnual));
      } else if (ratePctMonthly !== undefined && ratePctMonthly !== null && ratePctMonthly !== '') {
        bps = Math.round(Number(ratePctMonthly) * 12 * 100);
      } else return res.status(400).json({ error: 'ratePctMonthly (e.g. 0.5) or rateBpsAnnual required' });
      if (!Number.isFinite(bps) || bps < 0) return res.status(400).json({ error: 'invalid rate' });
      const penBps = Math.round(Number(penaltyPct ?? 0) * 100);
      if (!Number.isFinite(penBps) || penBps < 0 || penBps > 2000)
        return res.status(400).json({ error: 'penaltyPct must be between 0 and 20 (max 20%)' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      // Pre-flight: contract caps the rate at the tier-1 package APR — give a
      // clean 400 with the live cap instead of a revert.
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      const info = await c.methods.getValidatorInfo(acct.address).call().catch(() => null);
      if (info) {
        const pkgId = Number(info.selectedPackageId);
        if (!pkgId) return res.status(400).json({ error: 'no tier-1 package selected — stake into an admin package first' });
        const p = await c.methods.packages(pkgId).call().catch(() => null);
        if (p && bps > Number(p.aprBps)) {
          return res.status(400).json({
            error: 'rate exceeds your tier-1 package APR cap: max ' + (Number(p.aprBps) / 100) + '% annual = ' +
                   (Math.round(Number(p.aprBps) / 1200 * 10000) / 10000) + '% monthly',
            maxRateBpsAnnual: Number(p.aprBps),
            maxMonthlyPct: Math.round(Number(p.aprBps) / 1200 * 10000) / 10000,
          });
        }
      }
      const minWei = web3.utils.toWei(String(minDepositEln), 'ether');
      const r = await sendNodeTx(
        c.methods.addValidatorPackage(pkgName, Math.round(days * 86400), minWei, bps, penBps),
        0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, rateBpsAnnual: bps,
                 monthlyPct: Math.round(bps / 1200 * 10000) / 10000, penaltyBps: penBps });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: enable/disable one of YOUR tier-2 packages (existing
  //    positions keep their snapshotted terms). Body: { privateKey, idx, active }
  app.post('/api/apos/validator/set-package-active', async (req, res) => {
    try {
      const { privateKey, idx, active } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const i = parseInt(idx);
      if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'idx required (package index)' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.setValidatorPackageActive(i, !!active), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, idx: i, active: !!active });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: publish the public PROFILE rendered on /validator.html.
  //    Body: { privateKey, profile: {company, contact, address, website, about} | string }
  app.post('/api/apos/validator/set-profile', async (req, res) => {
    try {
      const { privateKey, profile } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      let json;
      if (profile && typeof profile === 'object') {
        const { company, contact, address, website, about } = profile;
        json = JSON.stringify({
          company: String(company || '').slice(0, 120),
          contact: String(contact || '').slice(0, 120),
          address: String(address || '').slice(0, 200),
          website: String(website || '').slice(0, 200),
          about:   String(about   || '').slice(0, 400),
        });
      } else {
        json = String(profile || '');
        try { JSON.parse(json); } catch { return res.status(400).json({ error: 'profile must be a JSON object' }); }
      }
      if (json.length > 1000) return res.status(400).json({ error: 'profile too long (max 1000 chars on-chain)' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.setProfile(json), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, profile: JSON.parse(json) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: CLAIM DAILY PROFIT — package APR accrues continuously on
  //    the self-stake; claimable any time from the reward pool (admin-pool
  //    fallback). Body: { privateKey }
  app.post('/api/apos/validator/claim-profit', async (req, res) => {
    try {
      const { privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      const pending = await c.methods.pendingValidatorProfit(acct.address).call().catch(() => '0');
      if (BigInt(pending.toString()) === 0n) {
        return res.status(400).json({ error: 'nothing accrued yet' });
      }
      const r = await sendNodeTx(c.methods.claimValidatorProfit(), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, claimedWei: pending.toString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: switch the selected package. ONE PACKAGE AT A TIME — only
  //    allowed once the current term has ended (re-locks to the new term).
  app.post('/api/apos/validator/select-package', async (req, res) => {
    try {
      const { privateKey, packageId } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      if (packageId === undefined || packageId === null || packageId === '')
        return res.status(400).json({ error: 'packageId required' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.selectPackage(parseInt(packageId)), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash, packageId: parseInt(packageId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: withdraw the package-locked STAKE principal (+APR after
  //    lock). Dropping the stake under the minimum demotes to BELOW_MIN.
  app.post('/api/apos/validator/withdraw-stake', async (req, res) => {
    try {
      const { privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.withdrawValidatorStake(), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: withdraw accrued gas-fee share (any time).
  app.post('/api/apos/validator/withdraw-fees', async (req, res) => {
    try {
      const { privateKey } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.withdrawValidatorFees(), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: name one of your delegators (panel display).
  app.post('/api/apos/validator/label-delegator', async (req, res) => {
    try {
      const { privateKey, delegator, label } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey || !delegator) return res.status(400).json({ error: 'privateKey + delegator required' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.labelDelegator(delegator, String(label || '')), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: hand a reward to one of your delegators (by hand,
  //    validator's own funds — recorded on-chain for the panel history).
  app.post('/api/apos/validator/distribute', async (req, res) => {
    try {
      const { privateKey, delegator, amountEther } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey || !delegator) return res.status(400).json({ error: 'privateKey + delegator required' });
      if (!amountEther || Number(amountEther) <= 0) return res.status(400).json({ error: 'amountEther > 0 required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const valueWei = web3.utils.toWei(String(amountEther), 'ether');
      const r = await sendNodeTx(c.methods.distributeToDelegator(delegator), valueWei, privateKey);
      res.json({ success: true, txHash: r.transactionHash, valueWei });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Delegator: fund a validator's pool (by code or by address) INTO one
  //    of the validator's tier-2 packages. Every deposit creates a NEW
  //    POSITION snapshotting the package's terms (rate, lock, penalty —
  //    grandfathered) and raises the ONE POOL → the tier.
  //    Body: { privateKey, code? , validator?, vpkgIdx, amountEther }
  app.post('/api/apos/delegate', async (req, res) => {
    try {
      const { privateKey, code, validator, vpkgIdx, amountEther } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      if (!code && !validator) return res.status(400).json({ error: 'code or validator required' });
      const pkgIdx = parseInt(vpkgIdx);
      if (!Number.isInteger(pkgIdx) || pkgIdx < 0)
        return res.status(400).json({ error: 'vpkgIdx required — choose one of the validator\'s packages (see /api/apos/vpackages/:validator)' });
      if (!amountEther || Number(amountEther) <= 0) return res.status(400).json({ error: 'amountEther > 0 required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      // The admin validator takes no delegators — reject before sending the tx
      // (the contract enforces this too; this gives a clean 400 instead of a revert).
      const adminAddr = await c.methods.admin().call().catch(() => null);
      let targetVal = validator;
      if (code) targetVal = await c.methods.codeToValidator(String(code)).call().catch(() => null);
      if (adminAddr && targetVal && String(targetVal).toLowerCase() === String(adminAddr).toLowerCase()) {
        return res.status(400).json({ error: 'the admin validator does not accept delegators' });
      }
      const valueWei = BigInt(web3.utils.toWei(String(amountEther), 'ether'));
      // Pre-flight the chosen package: exists, active, amount meets the
      // minimum — clean 400s instead of reverts.
      if (targetVal && _addrOk(targetVal)) {
        const vp = await c.methods.validatorPackages(targetVal, pkgIdx).call().catch(() => null);
        if (!vp || Number(vp.id) === 0) return res.status(400).json({ error: 'package #' + pkgIdx + ' does not exist for that validator' });
        if (!vp.active) return res.status(400).json({ error: 'package "' + vp.name + '" is currently disabled by the validator' });
        if (valueWei < BigInt(vp.minAmountWei.toString())) {
          return res.status(400).json({
            error: 'amount is below the package minimum (' + (Number(BigInt(vp.minAmountWei.toString()) / 1000000000000n) / 1e6) + ' ELN per deposit)',
            minAmountWei: vp.minAmountWei.toString(),
          });
        }
      }
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      // ONE PACKAGE PER DELEGATOR pre-flight: a delegator may only hold open
      // positions in ONE package of ONE validator. Top-ups of the SAME
      // validator+package pass; everything else gets a clean 400 naming the
      // active validator code + package instead of an on-chain revert.
      if (targetVal && _addrOk(targetVal)) try {
        const curVal = await c.methods.delegatorActiveValidator(acct.address).call();
        if (curVal && !/^0x0+$/.test(String(curVal).toLowerCase())) {
          const curIdxPlus1 = Number(await c.methods.delegatorActiveVpkgIdxPlus1(acct.address).call().catch(() => 0));
          const curIdx = curIdxPlus1 > 0 ? curIdxPlus1 - 1 : null;
          const sameValidator = targetVal && String(targetVal).toLowerCase() === String(curVal).toLowerCase();
          if (!sameValidator || curIdx !== pkgIdx) {
            let curCode = '', curPkgName = '';
            try { curCode = (await c.methods.getValidatorInfo(curVal).call()).code || ''; } catch {}
            if (curIdx !== null) {
              try { curPkgName = (await c.methods.validatorPackages(curVal, curIdx).call()).name || ''; } catch {}
            }
            const where = (curCode || curVal) + (curPkgName ? ' (package "' + curPkgName + '")' : '');
            return res.status(400).json({
              error: 'one package per delegator: you already delegate with validator ' + where +
                     ' — a delegator can only stake in ONE package of ONE validator. ' +
                     'Withdraw that package fully before joining a different validator/package. ' +
                     '(Top-ups of the same package are allowed.)',
              activeValidator: curVal,
              activeValidatorCode: curCode || null,
              activeVpkgIdx: curIdx,
            });
          }
        }
      } catch (e) { /* registry without the one-package getters — let the chain decide */ }
      const balanceWei = BigInt(await web3.eth.getBalance(acct.address));
      const gasPrice   = BigInt(await ctx.safeGasPrice());
      const needed     = valueWei + gasPrice * 700000n;
      if (balanceWei < needed) {
        return res.status(400).json({
          error: `Insufficient balance: wallet ${acct.address} has ${(Number(balanceWei)/1e18).toFixed(6)} ELN but needs ${(Number(needed)/1e18).toFixed(6)} ELN (delegation + gas).`,
          walletAddress: acct.address,
        });
      }
      const method = code
        ? c.methods.delegateByCode(String(code), pkgIdx)
        : c.methods.delegate(validator, pkgIdx);
      const r = await sendNodeTx(method, valueWei.toString(), privateKey);
      res.json({ success: true, txHash: r.transactionHash, valueWei: valueWei.toString(), vpkgIdx: pkgIdx });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Delegator: SELF-WITHDRAW a position — principal + accrued profit at
  //    the position's grandfathered rate. Exiting before the position's
  //    snapshotted lock term ends pays the package's penaltyBps on the
  //    withdrawn principal (kept by the validator).
  //    Body: { privateKey, validator, posIdx, amountEther }
  app.post('/api/apos/withdraw-position', async (req, res) => {
    try {
      const { privateKey, validator, posIdx, amountEther } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      if (!validator || !/^0x[0-9a-fA-F]{40}$/.test(String(validator))) return res.status(400).json({ error: 'validator address required' });
      const idx = parseInt(posIdx);
      if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'posIdx required (position index)' });
      if (!amountEther || Number(amountEther) <= 0) return res.status(400).json({ error: 'amountEther > 0 required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const amountWei = web3.utils.toWei(String(amountEther), 'ether');
      // Pre-flight: position must belong to the caller and cover the amount.
      const acct = web3.eth.accounts.privateKeyToAccount(privateKey);
      const d = await c.methods.delegations(validator, idx).call().catch(() => null);
      if (!d) return res.status(400).json({ error: 'position #' + idx + ' not found for that validator' });
      if (String(d.delegator).toLowerCase() !== acct.address.toLowerCase())
        return res.status(403).json({ error: 'position #' + idx + ' is not yours' });
      if (BigInt(amountWei) > BigInt(d.amount.toString()))
        return res.status(400).json({ error: 'amount exceeds the position principal (' + (Number(BigInt(d.amount.toString())) / 1e18) + ' ELN left)' });
      // Per-position early rule: penalty applies before since + lockSeconds
      // at the position's snapshotted penaltyBps.
      const lockSecs = Number(d.lockSeconds || 0);
      const penBps   = Number(d.penaltyBps || 0);
      const early = penBps > 0 && (Date.now() / 1000) < (Number(d.since) + lockSecs);
      const r = await sendNodeTx(c.methods.withdrawPosition(validator, idx, amountWei), 0, privateKey);
      res.json({
        success: true, txHash: r.transactionHash, amountWei,
        earlyPenaltyApplied: early,
        penaltyBps: penBps,
        note: early ? 'Withdrawn before the package lock ended — a ' + (penBps / 100) + '% early-exit penalty was deducted from the principal.' : undefined,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: return principal of one of its delegators' POSITIONS — no
  //    early penalty; the position's accrued profit is paid too.
  //    Body: { privateKey, delegator, posIdx, amountEther }
  app.post('/api/apos/validator/release', async (req, res) => {
    try {
      const { privateKey, delegator, posIdx, amountEther } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey || !delegator) return res.status(400).json({ error: 'privateKey + delegator required' });
      const idx = parseInt(posIdx);
      if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'posIdx required (position index)' });
      if (!amountEther || Number(amountEther) <= 0) return res.status(400).json({ error: 'amountEther > 0 required' });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const valueWei = web3.utils.toWei(String(amountEther), 'ether');
      const r = await sendNodeTx(c.methods.releaseToDelegator(delegator, idx, valueWei), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validator: publish the public offer (what you pay for pool filling).
  app.post('/api/apos/validator/set-offer', async (req, res) => {
    try {
      const { privateKey, offer } = req.body || {};
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.status(400).json({ error: 'No registry deployed' });
      if (!privateKey) return res.status(400).json({ error: 'privateKey required' });
      const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
      const r = await sendNodeTx(c.methods.setOffer(String(offer || '').slice(0, 500)), 0, privateKey);
      res.json({ success: true, txHash: r.transactionHash });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══ DELEGATION DESK — request + conversation channel ═══════════════
  // A delegator asks a validator "I want to fill your pool"; the validator
  // accepts/declines and the two keep a message thread. Stored server-side
  // on the ADMIN node (operator panels reach it via /api/admin-proxy).
  const DESK_PATH = path.join(ctx.dataDir || __dirname, 'delegation-desk.json');
  function deskLoad() { try { return JSON.parse(fs.readFileSync(DESK_PATH, 'utf8')); } catch { return { seq: 0, threads: [] }; } }
  function deskSave(d) { try { fs.writeFileSync(DESK_PATH, JSON.stringify(d, null, 2)); } catch {} }
  const _addrOk = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

  // v9.13 FIX — the desk must be ONE shared store for the whole network.
  // Previously each node kept its own delegation-desk.json, so a request
  // sent through the admin node's validator page never appeared in the
  // validator's panel on HIS node. Now OPERATOR nodes transparently forward
  // every /api/desk/* call to the ADMIN node (the single source of truth);
  // the admin node serves locally. Returns true if the request was proxied.
  async function deskForward(req, res) {
    try {
      const cfg = ctx.getConfig() || {};
      const role = String(cfg.role || process.env.NODE_ROLE || 'admin').toLowerCase();
      const adminBase = String(cfg.adminBootstrapUrl || process.env.ADMIN_URL || '').replace(/\/+$/, '');
      if (role !== 'operator' || !adminBase) return false;   // admin serves locally
      const r = await fetch(adminBase + req.originalUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'GET' ? undefined : JSON.stringify(req.body || {}),
      });
      const body = await r.text();
      res.status(r.status).type('application/json').send(body);
      return true;
    } catch (e) {
      res.status(502).json({ error: 'could not reach the admin node desk: ' + e.message });
      return true;
    }
  }

  // Delegator opens a request to a validator (by code or address) + first
  // message. Two-tier: the request may carry the chosen tier-2 package
  // (vpkgIdx) — recorded on the thread and shown to the validator.
  app.post('/api/desk/request', async (req, res) => {
    if (await deskForward(req, res)) return;
    try {
      const { code, validator, delegator, message, vpkgIdx } = req.body || {};
      if (!_addrOk(delegator)) return res.status(400).json({ error: 'delegator address required' });
      if (!message || String(message).trim().length < 3) return res.status(400).json({ error: 'write a short message to the validator' });
      let valAddr = validator;
      if (!_addrOk(valAddr) && code) {
        const cfg = ctx.getConfig();
        if (cfg?.aposRegistry) {
          const c = getRegistry(ctx.web3Ref(), cfg.aposRegistry);
          valAddr = await c.methods.codeToValidator(String(code)).call().catch(() => null);
        }
      }
      if (!_addrOk(valAddr) || /^0x0+$/.test(valAddr.toLowerCase())) return res.status(404).json({ error: 'validator not found' });
      // The admin validator takes no delegators — block desk requests to it.
      {
        const cfgA = ctx.getConfig();
        if (cfgA?.aposRegistry) {
          const adminAddr = await getRegistry(ctx.web3Ref(), cfgA.aposRegistry).methods.admin().call().catch(() => null);
          if (adminAddr && String(adminAddr).toLowerCase() === valAddr.toLowerCase()) {
            return res.status(400).json({ error: 'the admin validator does not accept delegators' });
          }
        }
      }
      // Optional: the tier-2 package the delegator wants to join. Validate it
      // exists and snapshot its display terms onto the thread for the panel.
      let vpkg = null;
      if (vpkgIdx !== undefined && vpkgIdx !== null && vpkgIdx !== '') {
        const i = parseInt(vpkgIdx);
        if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'invalid vpkgIdx' });
        const cfgP = ctx.getConfig();
        if (cfgP?.aposRegistry) {
          const cP = getRegistry(ctx.web3Ref(), cfgP.aposRegistry);
          const p = await cP.methods.validatorPackages(valAddr, i).call().catch(() => null);
          if (!p || Number(p.id) === 0) return res.status(400).json({ error: 'package #' + i + ' does not exist for that validator' });
          vpkg = {
            idx: i, name: p.name,
            lockDays: Math.round(Number(p.lockSeconds) / 86400),
            monthlyPct: Math.round(Number(p.rateBps) / 1200 * 10000) / 10000,
            rateBpsAnnual: Number(p.rateBps),
            penaltyPct: Number(p.penaltyBps) / 100,
            minAmountWei: p.minAmountWei.toString(),
          };
        }
      }
      const d = deskLoad();
      // One open thread per (validator, delegator) pair — append to it if it exists.
      let t = d.threads.find(t => t.validator.toLowerCase() === valAddr.toLowerCase()
        && t.delegator.toLowerCase() === String(delegator).toLowerCase() && t.status !== 'closed');
      if (!t) {
        t = { id: ++d.seq, validator: valAddr, delegator, status: 'open',
              createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        d.threads.push(t);
      }
      if (vpkg) { t.vpkgIdx = vpkg.idx; t.vpkg = vpkg; }
      t.messages.push({ from: 'delegator', body: String(message).slice(0, 2000), at: Date.now() });
      t.updatedAt = Date.now();
      deskSave(d);
      res.json({ success: true, id: t.id, status: t.status, vpkgIdx: vpkg ? vpkg.idx : undefined });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Either side reads their threads.
  app.get('/api/desk/for-validator/:address', async (req, res) => {
    if (await deskForward(req, res)) return;
    const d = deskLoad();
    res.json({ threads: d.threads.filter(t => t.validator.toLowerCase() === String(req.params.address).toLowerCase()) });
  });
  app.get('/api/desk/for-delegator/:address', async (req, res) => {
    if (await deskForward(req, res)) return;
    const d = deskLoad();
    res.json({ threads: d.threads.filter(t => t.delegator.toLowerCase() === String(req.params.address).toLowerCase()) });
  });

  // Reply on a thread (from: 'validator' | 'delegator', address must match the side).
  app.post('/api/desk/:id/reply', async (req, res) => {
    if (await deskForward(req, res)) return;
    try {
      const { from, address, body } = req.body || {};
      if (!['validator', 'delegator'].includes(from)) return res.status(400).json({ error: 'from must be validator|delegator' });
      if (!body || !String(body).trim()) return res.status(400).json({ error: 'empty message' });
      const d = deskLoad();
      const t = d.threads.find(t => t.id === Number(req.params.id));
      if (!t) return res.status(404).json({ error: 'thread not found' });
      const expected = from === 'validator' ? t.validator : t.delegator;
      if (!address || expected.toLowerCase() !== String(address).toLowerCase()) return res.status(403).json({ error: 'address does not match thread ' + from });
      t.messages.push({ from, body: String(body).slice(0, 2000), at: Date.now() });
      t.updatedAt = Date.now();
      deskSave(d);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Validator sets the thread status: accepted (delegator may deposit),
  // declined, or closed.
  app.post('/api/desk/:id/status', async (req, res) => {
    if (await deskForward(req, res)) return;
    try {
      const { address, status } = req.body || {};
      if (!['accepted', 'declined', 'closed', 'open'].includes(status)) return res.status(400).json({ error: 'bad status' });
      const d = deskLoad();
      const t = d.threads.find(t => t.id === Number(req.params.id));
      if (!t) return res.status(404).json({ error: 'thread not found' });
      if (!address || t.validator.toLowerCase() !== String(address).toLowerCase()) return res.status(403).json({ error: 'only the thread validator can set status' });
      t.status = status;
      t.updatedAt = Date.now();
      t.messages.push({ from: 'validator', body: '— request ' + status.toUpperCase() + ' —', at: Date.now(), system: true });
      deskSave(d);
      res.json({ success: true, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Earnings summary: validators' accumulated gas-fee shares + admin pool.
  //    (The L2 hook credits storage directly — no events — so we read totals.)
  app.get('/api/apos/credits', async (req, res) => {
    try {
      const cfg = ctx.getConfig();
      if (!cfg?.aposRegistry) return res.json({ deployed: false, credits: [] });
      const web3 = ctx.web3Ref();
      const c = getRegistry(web3, cfg.aposRegistry);
      const filterValidator = req.query.validator ? String(req.query.validator).toLowerCase() : null;
      const count = Number(await c.methods.getValidatorCount().call());
      const rows = [];
      let totalValidatorShare = 0n;
      for (let i = 0; i < count && i < 1024; i++) {
        const addr = await c.methods.validatorList(i).call();
        if (addr === '0x0000000000000000000000000000000000000000') continue;
        if (filterValidator && addr.toLowerCase() !== filterValidator) continue;
        const v = await c.methods.getValidatorInfo(addr).call();
        const acc = BigInt(v.accumulatedFees.toString());
        totalValidatorShare += acc;
        rows.push({
          kind: 'validator', address: addr, code: v.code || '',
          gasShareBps: Number(v.gasShareBps),
          accumulatedFeesWei: acc.toString(),
        });
      }
      const adminFees = await c.methods.adminAccumulatedFees().call();
      res.json({
        deployed: true,
        credits: rows,
        totalValidatorShareWei: totalValidatorShare.toString(),
        adminAccumulatedFeesWei: adminFees.toString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log('APOS endpoints mounted (v9 two-tier validator/delegator model)');
}

module.exports = { mount, loadBuild };
