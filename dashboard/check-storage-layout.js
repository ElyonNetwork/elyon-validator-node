// Storage-layout guard for UNPRegistry — the Nethermind consensus fee hook
// (APOSFeeDistributor.cs) reads contract storage DIRECTLY by slot:
//   slot  6 → mapping(address => Validator) validators
//   slot 17 → uint256 adminAccumulatedFees
//   slot 19 → mapping(address => string) validatorOffer
//   Validator struct offsets: status=+2, gasShareBps=+8, accumulatedFees=+10
// Any contract edit that moves these slots/offsets silently breaks L2 fee
// distribution. Run after editing UNPRegistry.sol:  node check-storage-layout.js
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const SRC = path.join(__dirname, '..', 'contracts', 'UNPRegistry.sol');
const source = fs.readFileSync(SRC, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'UNPRegistry.sol': { content: source } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['storageLayout'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter(e => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
const layout = out.contracts['UNPRegistry.sol'].UNPRegistry.storageLayout;
const storage = layout.storage;
const types = layout.types;

let failed = 0;
function assertSlot(label, slot) {
  const entry = storage.find(s => s.label === label);
  if (!entry) { console.error('FAIL: variable', label, 'not found'); failed++; return; }
  const ok = String(entry.slot) === String(slot);
  console.log((ok ? 'OK  ' : 'FAIL') + `: ${label} slot=${entry.slot} (expected ${slot})`);
  if (!ok) failed++;
}
assertSlot('validators', 6);
assertSlot('adminAccumulatedFees', 17);
assertSlot('validatorOffer', 19);

// Validator struct member offsets (slots within the struct).
const valEntry = storage.find(s => s.label === 'validators');
const mapType = types[valEntry.type];           // mapping(address => struct ...)
const structType = types[mapType.value];        // struct UNPRegistry.Validator
function assertMember(label, slot) {
  const m = structType.members.find(m => m.label === label);
  if (!m) { console.error('FAIL: Validator.' + label, 'not found'); failed++; return; }
  const ok = String(m.slot) === String(slot);
  console.log((ok ? 'OK  ' : 'FAIL') + `: Validator.${label} offset=+${m.slot} (expected +${slot})`);
  if (!ok) failed++;
}
assertMember('status', 2);
assertMember('gasShareBps', 8);
assertMember('accumulatedFees', 10);

console.log('\nFull top-level layout:');
for (const s of storage) console.log(`  slot ${String(s.slot).padStart(2)} offset ${s.offset}  ${s.label}  (${s.type})`);

if (failed) { console.error('\n' + failed + ' assertion(s) FAILED — consensus hook slot map is broken!'); process.exit(1); }
console.log('\nAll storage-layout assertions passed.');
