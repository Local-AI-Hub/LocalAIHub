#!/usr/bin/env node

const { inspectCleanupTargets, runCleanup } = require('../electron/services/storageCleanupService');

function formatBytes(bytes) {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = numeric;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${units[unitIndex]}`;
}

function printPreview(preview) {
  console.log(`Approved scan roots: ${preview.allowedRoots.join(', ') || 'None'}`);
  console.log(`Approved shortcut roots: ${(preview.allowedShortcutRoots || []).join(', ') || 'None'}`);
  console.log(`Found ${preview.totalEntries} leftover item(s) with about ${formatBytes(preview.totalBytes)} recoverable.`);

  for (const category of preview.categories || []) {
    console.log(`\n[${category.label}] ${category.entries.length} item(s), ${formatBytes(category.totalBytes)}`);
    for (const entry of category.entries) {
      console.log(`- ${entry.label}`);
      console.log(`  Path: ${entry.path}`);
      if (entry.shortcutTargetPath) {
        console.log(`  Target: ${entry.shortcutTargetPath}`);
      }
      console.log(`  Reason: ${entry.reason}`);
    }
  }
}

function printCleanupResult(result) {
  console.log(`Removed ${result.removedEntries.length} item(s) and recovered about ${formatBytes(result.removedBytes)}.`);

  if (result.failedEntries?.length) {
    console.log('\nFailed removals:');
    for (const entry of result.failedEntries) {
      console.log(`- ${entry.label || entry.path}`);
      console.log(`  Path: ${entry.path}`);
      console.log(`  Message: ${entry.message}`);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node scripts/remediate-local-ai-hub.js [--apply] [--json]');
    console.log('--apply  Remove the exact leftovers found in the audit.');
    console.log('--json   Print JSON instead of the human-readable report.');
    return;
  }

  if (args.has('--apply')) {
    const result = await runCleanup();
    if (args.has('--json')) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printCleanupResult(result);
    return;
  }

  const preview = await inspectCleanupTargets();
  if (args.has('--json')) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  printPreview(preview);
}

main().catch((error) => {
  console.error(error?.message || String(error) || 'Local AI Hub remediation failed.');
  process.exit(1);
});
