'use strict';
const fs = require('fs');
const Web3 = require('web3').default || require('web3');
const REGISTRY_BUILD = JSON.parse(fs.readFileSync('./apos-registry-build.json','utf8'));
const POINTER_BUILD  = JSON.parse(fs.readFileSync('./apos-pointer-build.json','utf8'));

(async () => {
  const report = JSON.parse(fs.readFileSync('./test-l2-report.json','utf8'));
  const adminWeb3 = new Web3('http://135.220.49.73:8545');
  const operatorWeb3 = new Web3('http://72.144.161.171:8545');
  const adminAddr = '0x93eBB2a4AEBEef9EB62301fc88Fc4E78c40513BA';
  const operatorAddr = '0xAeaB617A8d172F2977d0Bc505dC6133fffC0bd34';
  const reg = new adminWeb3.eth.Contract(REGISTRY_BUILD.abi, report.config.registry);
  const ptr = new adminWeb3.eth.Contract(POINTER_BUILD.abi, report.config.pointer);

  // CORRECT field names per ABI:
  // getNodeInfo: status, stake, feeBps, parent, child, childBps, fees   <- fees at idx 6
  // getTokenInfo: owner, name_, symbol_, status, stake, feeBps, fees, price  <- fees at idx 6
  // getContractInfo: owner, status, stake, feeBps, fees  <- fees at idx 4
  const fix = {};
  fix.admin = String(await reg.methods.adminAccumulatedFees().call());
  fix.pointerRegistry = await ptr.methods.registry().call();
  fix.pointerInSync = fix.pointerRegistry.toLowerCase() === report.config.registry.toLowerCase();

  const nA = await reg.methods.getNodeInfo(adminAddr).call();
  const nO = await reg.methods.getNodeInfo(operatorAddr).call();
  fix.adminNodeFees = String(nA.fees);
  fix.operatorNodeFees = String(nO.fees);
  fix.adminNodeStake = String(nA.stake);
  fix.operatorNodeStake = String(nO.stake);
  fix.adminNodeStatus = Number(nA.status);
  fix.operatorNodeStatus = Number(nO.status);

  fix.tokens = [];
  for (const t of report.phases.tokens) {
    const ti = await reg.methods.getTokenInfo(t.tokenAddr).call();
    fix.tokens.push({
      tokenAddr: t.tokenAddr,
      owner: t.wallet,
      status: Number(ti.status),
      stake: String(ti.stake),
      feeBps: String(ti.feeBps),
      fees: String(ti.fees),
    });
  }
  fix.contracts = [];
  for (const c of report.phases.contracts) {
    const ci = await reg.methods.getContractInfo(c.contractAddr).call();
    fix.contracts.push({
      contractAddr: c.contractAddr,
      owner: c.wallet,
      status: Number(ci.status),
      stake: String(ci.stake),
      feeBps: String(ci.feeBps),
      fees: String(ci.fees),
    });
  }

  // Recompute summary with correct numbers
  const baseAdmin = BigInt(report.phases.baselineFees.admin);
  const fAdmin = BigInt(fix.admin);
  const sumTokens = fix.tokens.reduce((a,t)=>a+BigInt(t.fees), 0n);
  const sumContracts = fix.contracts.reduce((a,c)=>a+BigInt(c.fees), 0n);
  const totalNode = BigInt(fix.adminNodeFees) + BigInt(fix.operatorNodeFees);

  fix.summary = {
    pointerInSync: fix.pointerInSync,
    parityAllMatch: report.summary.parityAllMatch,
    adminTrackerBaseline: String(baseAdmin),
    adminTrackerFinal: String(fAdmin),
    adminTrackerDelta: String(fAdmin - baseAdmin),
    adminNodeFees: fix.adminNodeFees,
    operatorNodeFees: fix.operatorNodeFees,
    adminVsOperatorNode_equal: BigInt(fix.adminNodeFees) === BigInt(fix.operatorNodeFees),
    tokensTotal: String(sumTokens),
    contractsTotal: String(sumContracts),
    grandTotalDistributed: String((fAdmin - baseAdmin) + totalNode + sumTokens + sumContracts),
  };

  console.log(JSON.stringify(fix, null, 2));

  // Save patched report
  report.finalFees_CORRECTED = fix;
  fs.writeFileSync('./test-l2-report.json', JSON.stringify(report, null, 2));
  console.log('\n--- written back to test-l2-report.json under finalFees_CORRECTED ---');
})();
