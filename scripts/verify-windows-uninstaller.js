const assert = require('assert');
const Module = require('module');
const path = require('path');
const calls = [];
let helpText = 'Qt Installer Framework\npurge\n--confirm-command';
let exitCode = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './commandService' && parent?.filename.endsWith('windowsUninstallService.js')) return { runCommand: async (command, args, options) => {
    calls.push({command,args,options});
    return {code: args.includes('--help') ? 0 : exitCode, stdout: args.includes('--help') ? helpText : '', stderr: ''};
  }};
  return originalLoad.call(this, request, parent, isMain);
};
const service = require('../electron/services/windowsUninstallService');
Module._load = originalLoad;
async function main() {
  const exe = path.join('D:\\Vendor App', 'maintenancetool.exe');
  await service.runWindowsUninstaller({uninstallString: '"' + exe + '" --uninstall'}, null, 'Test tool');
  assert.deepStrictEqual(calls.at(-1).args, ['purge', '--confirm-command']);
  assert.strictEqual(calls.at(-1).command, exe);
  calls.length = 0;
  await service.runWindowsUninstaller({uninstallString:'"D:\\App\\uninstall.exe"',quietUninstallString:'"D:\\App\\uninstall.exe" /S'},null);
  assert.strictEqual(calls.length,1);
  assert.deepStrictEqual(calls[0].args,['/S']);
  calls.length = 0;
  helpText = 'Unrelated maintenance tool';
  await service.runWindowsUninstaller({uninstallString:'"' + exe + '" --uninstall'},null);
  assert.deepStrictEqual(calls.at(-1).args,['--uninstall']);
  await service.runWindowsUninstaller({uninstallString:'msiexec.exe /I{ABC}'},null);
  assert.deepStrictEqual(calls.at(-1).args,['/X{ABC}','/qn','/norestart']);
  exitCode = 1;
  await assert.rejects(()=>service.runWindowsUninstaller({uninstallString:'"D:\\App\\uninstall.exe" /S'},null),/uninstall/);
  console.log('Windows uninstaller verification passed (Qt IFW, quiet command, non-Qt, MSI, failure).');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
