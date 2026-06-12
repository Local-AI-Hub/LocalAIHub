const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
function readSource(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}
const appSource = readSource('src', 'App.jsx');
const modelManagerSource = readSource('src', 'components', 'ModelManager.jsx');
const preloadSource = readSource('electron', 'preload.js');
const mainSource = readSource('electron', 'main.js');
const modelServiceSource = readSource('electron', 'services', 'modelService.js');
const statisticsServiceSource = readSource('electron', 'services', 'statisticsService.js');
const backgroundTaskSource = readSource('electron', 'services', 'backgroundTaskService.js');
const backgroundWorkerSource = readSource('electron', 'helpers', 'background_worker.js');
const pipelineSource = readSource('src', 'components', 'PipelineBuilderPanel.jsx');

function getFunctionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `Missing function marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end > start, `Missing function end marker after: ${startMarker}`);
  return source.slice(start, end);
}

function verifyModelManagerLifecycle() {
  assert(modelManagerSource.includes('export default function ModelManager({ isActive = true, tools, onToast })'), 'Model Manager should receive an explicit active-tab signal.');
  assert(modelManagerSource.includes('const browseIpcRequestIdRef = useRef(null);'), 'Model Manager should track the active catalog IPC request.');
  assert(modelManagerSource.includes("window.localAIHub.cancelModelBrowse(ipcRequestId).catch(() => null);"), 'Leaving Model Manager should cancel its active catalog request.');
  assert(modelManagerSource.includes('if (!activeRef.current || requestId !== browseRequestIdRef.current)'), 'Stale Model Manager responses should be ignored.');
  assert(modelManagerSource.includes('if (result?.canceled)'), 'Normal Model Manager cancellation should be handled separately from errors.');
  assert(modelManagerSource.includes('[isActive, selectedTool, selectedToolId, selectedSource, modelType, sort, taskType]'), 'Returning to Model Manager should trigger a fresh catalog request.');
  assert(modelManagerSource.includes('requestId: ipcRequestId'), 'Catalog requests should carry scoped request IDs.');
  assert(modelManagerSource.includes('const localIpcRequestIdRef = useRef(null);'), 'Downloaded-model inventory should track its own cancellable request.');
  assert(modelManagerSource.includes('window.localAIHub.listLocalModels({ requestId: ipcRequestId, toolId })'), 'Downloaded-model inventory should use the scoped Model Manager request boundary.');

  const browseBody = getFunctionBody(modelManagerSource, '  async function browse(options = {}) {', '  async function handleLoadMore()');
  assert(browseBody.includes("onToast(message, 'error')"), 'Real catalog errors should still surface while Model Manager is active.');
  assert(browseBody.indexOf('if (result?.canceled)') < browseBody.indexOf("onToast(message, 'error')"), 'Cancellation should be filtered before catalog errors are shown.');

  const downloadBody = getFunctionBody(modelManagerSource, '  async function handleDownload(item) {', '  async function handleDelete');
  assert(downloadBody.includes('window.localAIHub.downloadModel'), 'Model downloads should remain user-owned operations.');
  assert(!downloadBody.includes('cancelModelBrowse') && !downloadBody.includes('AbortController'), 'Leaving Model Manager must not cancel downloads.');
}

function verifyStatisticsLifecycle() {
  assert(appSource.includes("if (activeTab !== 'statistics') {\n      cancelStatisticsLoads();"), 'Leaving Statistics should invalidate active section loads.');
  assert(appSource.includes("const ipcRequestId = `statistics-${section}-${Date.now()}-${requestGeneration}`;"), 'Statistics sections should use fresh request IDs.');
  assert(appSource.includes("window.localAIHub.cancelStatisticsRequest(ipcRequestId).catch(() => null);"), 'Statistics should request main-process cancellation.');
  assert(appSource.includes("activeTabRef.current === 'statistics'"), 'Statistics should reject results after the tab becomes inactive.');
  assert(appSource.includes('statisticsSectionRequestIdRef.current[section] === requestGeneration'), 'Statistics should reject stale generations.');
  assert(appSource.includes('if (result?.canceled)'), 'Normal Statistics cancellation should be handled separately from errors.');
  assert(appSource.includes("loadStatistics({ silent: true });\n    return () => cancelStatisticsLoads();"), 'Returning to Statistics should start fresh tab-owned loading.');

  const loadBody = getFunctionBody(appSource, '  async function loadStatisticsSection(section, options = {}) {', '  async function loadStatistics(options = {}) {');
  assert(loadBody.indexOf('if (result?.canceled)') < loadBody.indexOf('if (!result?.ok)'), 'Statistics cancellation should be filtered before errors are handled.');
  assert(loadBody.includes("pushToast(message, 'error')"), 'Real Statistics errors should still surface for active requests.');
}

function verifyScopedIpcAndServices() {
  assert(preloadSource.includes("cancelModelBrowse: (requestId) => invoke('models:cancel-browse', { requestId })"), 'Preload should expose only scoped Model Manager cancellation.');
  assert(preloadSource.includes("cancelStatisticsRequest: (requestId) => invoke('settings:cancel-statistics-request', { requestId })"), 'Preload should expose only scoped Statistics cancellation.');
  assert(mainSource.includes("modelCatalog: new Map()") && mainSource.includes("statistics: new Map()"), 'Main should keep separate cancellation scopes.');
  assert(mainSource.includes("runTabOwnedRequest(event, payload, 'modelCatalog'"), 'Model catalog IPC should register a scoped abort signal.');
  assert(mainSource.includes("ipcMain.handle('models:list-local', (event, payload = {})"), 'Downloaded-model inventory should share the scoped Model Manager cancellation boundary.');
  assert(mainSource.includes("runTabOwnedRequest(event, payload, 'statistics'"), 'Statistics IPC should register scoped abort signals.');
  assert(mainSource.includes('options.allowCancellation && isCancellationError(error)'), 'Normal IPC cancellation should not become a user-facing error.');
  assert(modelServiceSource.includes('const MODEL_BROWSE_CONTEXT = new AsyncLocalStorage();'), 'Model catalog fetches should receive request-local abort signals.');
  assert(modelServiceSource.includes('fetch(url, withModelBrowseSignal(options))'), 'Remote JSON catalog fetches should be abortable.');
  assert(modelServiceSource.includes('throwIfModelBrowseCanceled();'), 'Catalog parsing loops should check for cancellation.');
  assert(statisticsServiceSource.includes('calculatePathSize(tool.installDir, { signal: options.signal })'), 'Statistics install scans should pass cancellation into path sizing.');
  assert(statisticsServiceSource.includes('listDownloadedModels(tool, { signal: options.signal })'), 'Statistics model inventory should pass cancellation into local model walks.');
  assert(backgroundTaskSource.includes('worker.postMessage({ cancelRequestId: requestId })'), 'Worker-backed scans should receive cancellation messages.');
  assert(backgroundWorkerSource.includes('throwIfRequestCanceled(requestId);'), 'Long filesystem walks should check cancellation repeatedly.');
}

function verifyUnaffectedAreas() {
  assert(!pipelineSource.includes('cancelModelBrowse') && !pipelineSource.includes('cancelStatisticsRequest'), 'Pipelines should not participate in tab-load cancellation.');
  assert(!mainSource.includes("runTabOwnedRequest(event, payload, 'pipelines'"), 'Pipeline execution lifecycle should remain outside tab-owned cancellation.');
  assert(!modelManagerSource.includes('cancelPipelineRun') && !appSource.includes("cancelPipelineRun(activePipelineRun"), 'Tab navigation should not cancel active pipeline runs.');
}

async function verifyBackgroundTaskAbort() {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { isPackaged: false } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const { disposeBackgroundTasks, runBackgroundTask } = require('../electron/services/backgroundTaskService');
  Module._load = originalLoad;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-hub-tab-cancel-'));
  try {
    for (let index = 0; index < 200; index += 1) {
      const directory = path.join(tempRoot, `folder-${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'data.bin'), Buffer.alloc(512));
    }
    const controller = new AbortController();
    const scan = runBackgroundTask('calculate-path-size', { targetPath: tempRoot }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(scan, (error) => error?.name === 'AbortError', 'In-flight worker scans should reject as normal cancellation.');
  } finally {
    await disposeBackgroundTasks();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function main() {
  verifyModelManagerLifecycle();
  verifyStatisticsLifecycle();
  verifyScopedIpcAndServices();
  verifyUnaffectedAreas();
  await verifyBackgroundTaskAbort();
  console.log('Tab background cancellation verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});