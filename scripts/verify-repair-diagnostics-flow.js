const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  SUPPORT_GUIDANCE_TEXT,
  appendSupportGuidance,
  getRecentSupportEvents,
  recordSupportEvent,
} = require('../electron/services/supportEventService');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function assertYamlShape(source, fileName) {
  assert(!/\t/.test(source), `${fileName} should not contain tabs.`);
  if (fileName.endsWith('config.yml')) {
    assert(/^blank_issues_enabled:\s+/m.test(source), `${fileName} should configure blank issues.`);
    assert(/^contact_links:\s*$/m.test(source), `${fileName} should declare contact links.`);
    return;
  }
  assert(/^name:\s+/m.test(source), `${fileName} should declare a name.`);
  assert(/^body:\s*$/m.test(source), `${fileName} should declare a body.`);
  assert(/type:\s+(?:markdown|input|textarea|dropdown|checkboxes)/.test(source), `${fileName} should contain issue-form fields.`);
}

function main() {
  const guidance = appendSupportGuidance('Local AI Hub could not repair ComfyUI.');
  assert(guidance.includes('Settings -> Support and Diagnostics'), 'Guidance should point to Settings -> Support and Diagnostics.');
  assert(guidance.includes('Copy system info'), 'Guidance should mention Copy system info.');
  assert(guidance.includes('Create a diagnostics bundle') || guidance.includes('diagnostics bundle'), 'Guidance should mention diagnostics bundles.');
  assert(guidance.includes('GitHub issue'), 'Guidance should point to the GitHub issue flow.');
  assert(guidance.includes('do not share secrets'), 'Guidance should warn against sharing secrets.');
  assert.strictEqual(appendSupportGuidance(guidance), guidance, 'Guidance should not be appended twice.');

  recordSupportEvent({
    area: 'repair',
    toolId: 'comfyui',
    operation: 'repair',
    error: new Error('Authorization: Bearer github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II at C:\\Users\\Matthew\\Private\\model.safetensors'),
  });
  const event = getRecentSupportEvents({ limit: 1 })[0];
  assert.strictEqual(event.area, 'repair', 'Recent support events should preserve area.');
  assert.strictEqual(event.operation, 'repair', 'Recent support events should preserve operation.');
  assert(!event.message.includes('github_pat_'), 'Recent support events must redact PATs.');
  assert(!event.message.includes('C:\\Users\\Matthew'), 'Recent support events must redact user paths.');
  assert(!event.message.includes('model.safetensors'), 'Recent support events must redact model filenames.');

  const installerSource = read('electron/services/installerService.js');
  assert(installerSource.includes('appendSupportGuidance(readableMessage)'), 'Install failures should append support guidance.');
  assert(installerSource.includes('buildRepairFailureMessage(error, manifest)'), 'Repair failures should use the guided repair failure message.');
  assert(installerSource.includes("area: 'installer'"), 'Install failures should record support events.');
  assert(installerSource.includes("area: 'repair'"), 'Repair failures should record support events.');

  const runtimeRecoverySource = read('electron/services/runtimeRecoveryService.js');
  assert(runtimeRecoverySource.includes('appendSupportGuidance(message)'), 'Runtime recovery failures should append support guidance.');
  assert(runtimeRecoverySource.includes("area: 'readiness'"), 'Runtime recovery failures should record readiness events.');

  const processSource = read('electron/services/processService.js');
  assert(processSource.includes('const guidedMessage = appendSupportGuidance(message);'), 'Launch/readiness failures should persist support guidance.');
  assert(processSource.includes("operation: 'launch'"), 'Launch/readiness failures should record launch events.');

  const modelSource = read('electron/services/modelService.js');
  assert(modelSource.includes("area: 'model-manager'"), 'Model Manager failures should record support events.');
  assert(modelSource.includes('operation: /integrity|checksum|sha-?256|partial file/i'), 'Model download failures should classify integrity failures.');

  const diagnosticsSource = read('electron/services/diagnosticsService.js');
  assert(diagnosticsSource.includes('model-manager-health.json'), 'Diagnostics bundle should include Model Manager health.');
  assert(diagnosticsSource.includes('recentFailures'), 'Diagnostics should include recent failure summaries.');

  const settingsSource = read('src/components/SettingsPanel.jsx');
  assert(settingsSource.includes('sanitized Model Manager health counts/status'), 'Settings should describe sanitized Model Manager diagnostics.');

  const troubleshooting = read('docs/troubleshooting.md');
  assert(troubleshooting.includes('Settings -> Support and Diagnostics'), 'Troubleshooting should reference Support and Diagnostics.');
  assert(troubleshooting.includes('damaged or incomplete package'), 'Troubleshooting should cover damaged/incomplete packages.');
  assert(troubleshooting.includes('integrity or preflight'), 'Troubleshooting should cover integrity/preflight failures.');
  assert(/scan warnings/i.test(troubleshooting), 'Troubleshooting should cover scan warnings.');
  assert(troubleshooting.includes('preview URL'), 'Troubleshooting should cover preview URL allowlist/fallbacks.');
  assert(troubleshooting.includes('Never attach model files'), 'Troubleshooting should warn against sharing model files.');

  for (const file of ['bug_report.yml', 'troubleshooting_help.yml', 'feature_request.yml', 'config.yml']) {
    const source = read(`.github/ISSUE_TEMPLATE/${file}`);
    assertYamlShape(source, file);
  }
  const bugTemplate = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert(bugTemplate.includes('Model Manager operation'), 'Bug template should ask for Model Manager operation.');
  assert(bugTemplate.includes('Copy system info'), 'Bug template should ask for Copy system info.');
  assert(bugTemplate.includes('Review diagnostics'), 'Bug template should ask users to review diagnostics.');

  const helpTemplate = read('.github/ISSUE_TEMPLATE/troubleshooting_help.yml');
  assert(helpTemplate.includes('Model Manager source/provider'), 'Troubleshooting template should ask for Model Manager source/provider.');
  assert(helpTemplate.includes('Create diagnostics bundle'), 'Troubleshooting template should ask for diagnostics bundle when safe.');

  assert(SUPPORT_GUIDANCE_TEXT.length < 360, 'Support guidance should stay concise.');
  console.log('Repair diagnostics flow verifier passed.');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
