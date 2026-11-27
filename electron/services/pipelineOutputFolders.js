const fs = require('fs-extra');
const path = require('path');
const { getAppPaths } = require('./configService');
const { assertNoReparsePointTraversal } = require('./pathSafetyService');

const marker = 'output-folder.json';
function nameOf(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[.]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('Choose a folder name of 1 to 80 characters that is valid on Windows.');
  }
  return name;
}
function root() { return path.join(getAppPaths().runtimesRoot,'output-folders'); }
async function listOutputFolders() {
  await assertNoReparsePointTraversal(getAppPaths().runtimesRoot, root());
  const entries = await fs.readdir(root(), {withFileTypes:true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name).sort((a,b)=>a.localeCompare(b));
}
async function createOutputFolder(value) {
  const name = nameOf(value);
  const existing = (await listOutputFolders()).find(f => f.toLowerCase() === name.toLowerCase());
  const target = path.join(root(),existing || name);
  await assertNoReparsePointTraversal(getAppPaths().runtimesRoot,target);
  await fs.ensureDir(target);
  return existing || name;
}
async function assignRunFolder(runDirectory, value) {
  if (!value) return;
  const folder = await createOutputFolder(value);
  await fs.writeJson(path.join(runDirectory,marker),{folder});
}
async function readMembership(run) {
  const file = path.join(run, marker);
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return {folder:'', assignments:new Map()};
  if (!stat.isFile()) throw new Error('The saved output folder record is not a regular file.');
  const record = await fs.readJson(file);
  return {folder:record.folder || '', assignments:new Map(Object.entries(record.outputs || {}))};
}
function folderFor(record, filename) {
  return record.assignments.get(filename.toLowerCase()) ?? record.folder;
}
async function saveMembership(run, record) {
  const file = path.join(run,marker);
  if (!record.folder && !record.assignments.size) return fs.remove(file);
  const temporary = file + '.' + require('crypto').randomUUID() + '.tmp';
  try {
    await fs.writeJson(temporary,{folder:record.folder,outputs:Object.fromEntries(record.assignments)});
    await fs.rename(temporary,file);
  } finally { await fs.remove(temporary); }
}
module.exports = {listOutputFolders,createOutputFolder,assignRunFolder,readMembership,saveMembership,folderFor,nameOf,marker,root};
