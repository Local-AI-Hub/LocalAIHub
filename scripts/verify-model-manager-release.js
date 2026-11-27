const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checks = [
  'verify-model-download-plans',
  'verify-model-manager-search-names',
  'verify-model-collection-index',
  'verify-agent-model-manager',
  'verify-model-search-audit',
  'verify-model-manager-inventory-correctness',
  'verify-model-manager-selection-provenance',
  'verify-model-manager-review',
];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'model-manager-gate-'));
try {
  for (const check of checks) {
    console.log(check);
    execFileSync(process.execPath, [path.join(__dirname, check + '.js')], {
      stdio: 'inherit',
      env: { ...process.env, APPDATA: path.join(profile, check, 'roaming'), LOCALAPPDATA: path.join(profile, check, 'local') },
    });
  }
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
