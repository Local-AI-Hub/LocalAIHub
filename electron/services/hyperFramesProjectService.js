const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const { ensureStorage, getAppPaths } = require('./configService');
const { buildFileArtifact } = require('./pipelineArtifactService');
const {
  DEFAULT_STAGING_LIMITS,
  HYPERFRAMES_LOCAL_ASSETS_ERROR,
  copyCompositionProjectSafely,
  scanStagedCompositionForRemoteReferences,
} = require('./hyperFramesRenderService');
const {
  createEdge,
  createEmptyPipeline,
  createNode,
} = require('../shared/pipelineSchema.cjs');
const {
  assertNoReparsePointTraversal,
  assertPathInside,
  assertRealPathInside,
  isPathInside,
} = require('./pathSafetyService');

const PROJECT_SCHEMA_VERSION = 1;
const PROJECTS_DIRECTORY_NAME = 'hyperframes';
const PROJECT_MANIFEST_FILE = 'project.json';
const PROJECT_ENTRY_FILE = 'index.html';
const PROJECT_CREATED_BY = 'LocalAIHub';
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PROJECT_TREE_LIMITS = Object.freeze({
  ...DEFAULT_STAGING_LIMITS,
  maxDepth: 10,
  maxFiles: 1200,
  maxTotalBytes: 256 * 1024 * 1024,
});
const PROJECT_FILE_BROWSER_LIMITS = Object.freeze({
  maxDepth: 8,
  maxEntries: 800,
  maxTotalBytes: 256 * 1024 * 1024,
});
const MAX_EDITABLE_TEXT_FILE_BYTES = 256 * 1024;
const MAX_NEW_TEXT_FILE_BYTES = MAX_EDITABLE_TEXT_FILE_BYTES;
const MAX_ASSET_FILE_BYTES = 75 * 1024 * 1024;
const MAX_PROJECT_TOTAL_BYTES = 512 * 1024 * 1024;
const PROJECT_ASSETS_DIRECTORY = 'assets';
const EDITABLE_TEXT_EXTENSIONS = Object.freeze(['.html', '.css', '.js', '.md', '.txt']);
const SAFE_DATA_JSON_EXTENSIONS = Object.freeze(['.json']);
const EDITABLE_FILE_EXTENSIONS = Object.freeze([...EDITABLE_TEXT_EXTENSIONS]);
const TEXT_HEALTH_EXTENSIONS = new Set([...EDITABLE_TEXT_EXTENSIONS, ...SAFE_DATA_JSON_EXTENSIONS]);
const ASSET_FILE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.wav', '.mp3', '.m4a', '.ogg', '.mp4', '.webm', '.mov', '.ttf', '.otf', '.woff', '.woff2']);
const ASSET_FILE_EXTENSION_SET = new Set(ASSET_FILE_EXTENSIONS);
const BLOCKED_PROJECT_ENTRY_NAMES = new Set(['.git', '.hg', '.svn', '.gitkeep', '.cache', '.hyperframes-cache', 'node_modules', 'npm-cache', 'browser-profile', 'chrome', 'chrome-headless-shell', 'tmp', 'temp']);
const RESERVED_WINDOWS_DEVICE_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);
const LOCAL_ONLY_POLICY_MESSAGE = 'This first HyperFrames integration supports local project assets only. Remote http, https, and data references are blocked.';
const BUILT_IN_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'animated-title-card',
    version: 1,
    label: 'Animated title card',
    description: 'A compact animated title card with local HTML, CSS, and JavaScript only.',
  }),
  Object.freeze({
    id: 'lower-third-caption',
    version: 1,
    label: 'Lower-third caption',
    description: 'A simple lower-third and caption composition for short clips.',
  }),
  Object.freeze({
    id: 'kinetic-text-scene',
    version: 1,
    label: 'Kinetic text scene',
    description: 'A kinetic text scene with a few timed beats and simple local animation.',
  }),
]);
const BUILT_IN_TEMPLATE_BY_ID = new Map(BUILT_IN_TEMPLATES.map((template) => [template.id, template]));
const BLANK_PROJECT = Object.freeze({
  id: 'blank',
  version: 1,
  label: 'Blank Project',
  description: 'A minimal renderable scaffold for composing from scratch with local HTML, CSS, and JavaScript.',
  sourceType: 'blank-scaffold',
});
const FORBIDDEN_MANIFEST_KEYS = new Set([
  'args',
  'browserPath',
  'command',
  'commands',
  'externalPath',
  'filePath',
  'folderPath',
  'path',
  'remoteUrl',
  'script',
  'secret',
  'sourceCode',
]);
let operationQueue = Promise.resolve();

function queueOperation(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => null);
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeDisplayName(value, fallback = 'Untitled HyperFrames Project') {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

function sanitizeDescription(value) {
  return String(value || '')
    .replace(/[\r\t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1000);
}

function slugify(value, fallback = 'hyperframes-project') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function sanitizeProjectId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SAFE_ID_PATTERN.test(normalized)) {
    throw new Error('Local AI Hub refused to use an invalid HyperFrames project identifier.');
  }
  return normalized;
}

function createProjectId(displayName) {
  return `${slugify(displayName)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function getHyperFramesProjectsRoot(options = {}) {
  const appPaths = options.managedRoot
    ? { managedRoot: path.resolve(String(options.managedRoot)) }
    : getAppPaths();
  const projectsRoot = path.resolve(appPaths.projectsRoot || path.join(appPaths.managedRoot, 'projects'));
  return path.join(projectsRoot, PROJECTS_DIRECTORY_NAME);
}

function getTemplateResourcesRoot() {
  return path.resolve(path.join(__dirname, '..', 'resources', 'hyperframes-templates'));
}

function getBlankProjectResourcesDir() {
  return path.resolve(path.join(__dirname, '..', 'resources', 'hyperframes-blank-project'));
}

function getProjectSourceType(templateId, requestedSourceType = '') {
  if (templateId === BLANK_PROJECT.id) return BLANK_PROJECT.sourceType;
  if (BUILT_IN_TEMPLATE_BY_ID.has(templateId)) return 'starter-template';
  return String(requestedSourceType || '').trim() === 'blank-scaffold' ? 'blank-scaffold' : 'managed-project';
}

function getProjectTemplateLabel(templateId) {
  if (templateId === BLANK_PROJECT.id) return BLANK_PROJECT.label;
  return BUILT_IN_TEMPLATE_BY_ID.get(templateId)?.label || 'Unknown';
}

function resolveTemplateDir(templateId) {
  const template = BUILT_IN_TEMPLATE_BY_ID.get(String(templateId || '').trim());
  if (!template) {
    throw new Error('Choose one of the built-in HyperFrames templates before creating a project.');
  }
  const templateRoot = getTemplateResourcesRoot();
  const templateDir = path.resolve(path.join(templateRoot, template.id));
  return {
    template,
    templateDir: assertPathInside(templateRoot, templateDir, 'Local AI Hub refused to use a template outside the app package.'),
  };
}

function resolveProjectDir(projectId, options = {}) {
  const safeProjectId = sanitizeProjectId(projectId);
  const projectsRoot = path.resolve(getHyperFramesProjectsRoot(options));
  const projectDir = path.resolve(path.join(projectsRoot, safeProjectId));
  return {
    projectDir: assertPathInside(projectsRoot, projectDir, 'Local AI Hub refused to use a HyperFrames project outside managed storage.'),
    projectId: safeProjectId,
    projectsRoot,
  };
}

function getManifestPath(projectDir) {
  return path.join(projectDir, PROJECT_MANIFEST_FILE);
}

async function writeJsonAtomic(targetPath, value) {
  await fs.ensureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.move(tempPath, targetPath, { overwrite: true });
}

function inspectManifestForForbiddenKeys(value, trail = []) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = inspectManifestForForbiddenKeys(value[index], [...trail, String(index)]);
      if (found) return found;
    }
    return '';
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_MANIFEST_KEYS.has(String(key || '').trim())) {
      return [...trail, key].join('.');
    }
    const found = inspectManifestForForbiddenKeys(entry, [...trail, key]);
    if (found) return found;
  }
  return '';
}

function normalizeProjectManifest(source, options = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('The HyperFrames project manifest is not valid JSON metadata.');
  }
  const forbiddenKey = inspectManifestForForbiddenKeys(source);
  if (forbiddenKey) {
    throw new Error('The HyperFrames project manifest contains fields that Local AI Hub does not allow for managed projects.');
  }
  const projectId = sanitizeProjectId(source.projectId || options.projectId);
  if (options.projectId && projectId !== sanitizeProjectId(options.projectId)) {
    throw new Error('The HyperFrames project manifest does not match its managed project folder.');
  }
  if (Number(source.schemaVersion) !== PROJECT_SCHEMA_VERSION) {
    throw new Error('This HyperFrames project uses an unsupported manifest schema version.');
  }
  if (source.entryFile !== PROJECT_ENTRY_FILE) {
    throw new Error('Managed HyperFrames projects must use index.html as the entry file.');
  }
  if (source.localAssetsOnly !== true) {
    throw new Error('Managed HyperFrames projects must be marked local-assets-only.');
  }
  if (source.appCreated !== true || String(source.createdBy || '') !== PROJECT_CREATED_BY) {
    throw new Error('This folder was not created as a managed Local AI Hub HyperFrames project.');
  }
  const templateId = String(source.templateId || '').trim();
  const template = BUILT_IN_TEMPLATE_BY_ID.get(templateId) || null;
  const sourceType = getProjectSourceType(templateId, source.sourceType);
  const createdAt = source.createdAt || nowIso();
  const updatedAt = source.updatedAt || createdAt;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    displayName: sanitizeDisplayName(source.displayName, 'Untitled HyperFrames Project'),
    templateId,
    templateVersion: Math.max(1, Number(source.templateVersion || template?.version || (templateId === BLANK_PROJECT.id ? BLANK_PROJECT.version : 1)) || 1),
    sourceType,
    entryFile: PROJECT_ENTRY_FILE,
    createdAt,
    updatedAt,
    localAssetsOnly: true,
    appCreated: true,
    createdBy: PROJECT_CREATED_BY,
    ...(sanitizeDescription(source.description) ? { description: sanitizeDescription(source.description) } : {}),
  };
}

function buildProjectManifest({ projectId, displayName, templateId, templateVersion, sourceType, description, createdAt }) {
  const now = nowIso();
  return normalizeProjectManifest({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    displayName,
    templateId,
    templateVersion,
    sourceType,
    entryFile: PROJECT_ENTRY_FILE,
    createdAt: createdAt || now,
    updatedAt: now,
    localAssetsOnly: true,
    appCreated: true,
    createdBy: PROJECT_CREATED_BY,
    ...(sanitizeDescription(description) ? { description: sanitizeDescription(description) } : {}),
  });
}

async function inspectTreeSafety(rootPath, limits = PROJECT_TREE_LIMITS) {
  const activeLimits = {
    maxDepth: Math.max(1, Number(limits.maxDepth || PROJECT_TREE_LIMITS.maxDepth) || PROJECT_TREE_LIMITS.maxDepth),
    maxFiles: Math.max(1, Number(limits.maxFiles || PROJECT_TREE_LIMITS.maxFiles) || PROJECT_TREE_LIMITS.maxFiles),
    maxTotalBytes: Math.max(1, Number(limits.maxTotalBytes || PROJECT_TREE_LIMITS.maxTotalBytes) || PROJECT_TREE_LIMITS.maxTotalBytes),
  };
  const state = { fileCount: 0, totalBytes: 0 };
  async function visit(currentPath, depth) {
    if (depth > activeLimits.maxDepth) {
      throw new Error('This HyperFrames project is deeper than Local AI Hub can safely inspect.');
    }
    const stats = await fs.lstat(currentPath);
    if ((typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) || (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())) {
      throw new Error('This HyperFrames project contains a symlink or junction. Copy assets into the project folder before rendering.');
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(currentPath);
      for (const entry of entries) {
        await visit(path.join(currentPath, entry), depth + 1);
      }
      return;
    }
    if (!stats.isFile()) return;
    state.fileCount += 1;
    state.totalBytes += Number(stats.size || 0);
    if (state.fileCount > activeLimits.maxFiles) {
      throw new Error('This HyperFrames project has more files than Local AI Hub can safely inspect.');
    }
    if (state.totalBytes > activeLimits.maxTotalBytes) {
      throw new Error('This HyperFrames project is larger than Local AI Hub can safely inspect.');
    }
  }
  await visit(rootPath, 0);
  return state;
}

function buildHealth(status, message, runnable = false, details = {}) {
  return { status, message, runnable: Boolean(runnable), ...details };
}

async function readManifestForProject(projectDir, projectId) {
  const manifestPath = getManifestPath(projectDir);
  if (!(await fs.pathExists(manifestPath))) {
    return { manifest: null, health: buildHealth('missing-manifest', 'This folder is missing project.json, so it can be inspected but not rendered.') };
  }
  let raw;
  try {
    raw = await fs.readJson(manifestPath);
  } catch {
    return { manifest: null, health: buildHealth('malformed-manifest', 'The project.json file is not valid JSON, so this project cannot be rendered.') };
  }
  try {
    return { manifest: normalizeProjectManifest(raw, { projectId }), health: null };
  } catch (error) {
    return { manifest: null, health: buildHealth('invalid-manifest', error?.message || 'The project manifest is not valid for managed HyperFrames projects.') };
  }
}

async function inspectHyperFramesProject(projectId, options = {}) {
  const { projectDir, projectsRoot, projectId: safeProjectId } = resolveProjectDir(projectId, options);
  await fs.ensureDir(projectsRoot);
  const exists = await fs.pathExists(projectDir);
  if (!exists) {
    throw new Error('That HyperFrames project no longer exists on this PC.');
  }
  try {
    await assertRealPathInside(projectsRoot, projectDir, 'Local AI Hub refused to inspect a HyperFrames project outside managed storage.');
    await assertNoReparsePointTraversal(projectsRoot, projectDir, 'Local AI Hub refused to inspect that HyperFrames project because it crosses a symlink or junction.');
  } catch (error) {
    return {
      projectId: safeProjectId,
      displayName: safeProjectId,
      templateId: '',
      templateLabel: 'Unknown',
      createdAt: null,
      updatedAt: null,
      localAssetsOnly: false,
      health: buildHealth('unsafe-path', error?.message || 'Local AI Hub refused to inspect this project path.'),
    };
  }

  const manifestResult = await readManifestForProject(projectDir, safeProjectId);
  const fallbackManifest = manifestResult.manifest || {
    projectId: safeProjectId,
    displayName: safeProjectId,
    templateId: '',
    templateVersion: 0,
    sourceType: 'managed-project',
    localAssetsOnly: false,
    createdAt: null,
    updatedAt: null,
    description: '',
  };
  if (manifestResult.health) {
    return {
      ...fallbackManifest,
      templateLabel: getProjectTemplateLabel(fallbackManifest.templateId),
      health: manifestResult.health,
    };
  }

  const entryPath = path.join(projectDir, PROJECT_ENTRY_FILE);
  if (!(await fs.pathExists(entryPath))) {
    return {
      ...fallbackManifest,
      templateLabel: getProjectTemplateLabel(fallbackManifest.templateId),
      health: buildHealth('missing-entry', 'This project is missing index.html, so it cannot be rendered.'),
    };
  }

  try {
    assertPathInside(projectDir, entryPath, 'Local AI Hub refused to use a HyperFrames entry file outside the project folder.');
    await assertRealPathInside(projectDir, entryPath, 'Local AI Hub refused to use a HyperFrames entry file outside the project folder.');
    await inspectTreeSafety(projectDir, options.limits || PROJECT_TREE_LIMITS);
    const scan = await scanStagedCompositionForRemoteReferences(projectDir, options.limits || PROJECT_TREE_LIMITS);
    return {
      ...fallbackManifest,
      templateLabel: getProjectTemplateLabel(fallbackManifest.templateId),
      health: buildHealth('healthy', 'This managed HyperFrames project is ready for the pipeline.', true, {
        scannedFileCount: scan.scannedFileCount,
        scannedExtensions: scan.scannedExtensions,
      }),
    };
  } catch (error) {
    return {
      ...fallbackManifest,
      templateLabel: getProjectTemplateLabel(fallbackManifest.templateId),
      health: buildHealth(error?.code === 'HYPERFRAMES_REMOTE_REFERENCE' ? 'remote-references' : 'unsafe-project', error?.message || HYPERFRAMES_LOCAL_ASSETS_ERROR),
    };
  }
}

async function listHyperFramesProjectTemplates() {
  return {
    blankProject: { ...BLANK_PROJECT, localAssetsOnly: true },
    templates: BUILT_IN_TEMPLATES.map((template) => ({ ...template, localAssetsOnly: true, sourceType: 'starter-template' })),
  };
}

async function listHyperFramesProjects(options = {}) {
  const projectsRoot = path.resolve(getHyperFramesProjectsRoot(options));
  await fs.ensureDir(projectsRoot);
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = String(entry.name || '').trim();
    if (!SAFE_ID_PATTERN.test(id)) {
      projects.push({
        projectId: id,
        displayName: id || 'Unknown folder',
        templateId: '',
        templateLabel: 'Unknown',
        createdAt: null,
        updatedAt: null,
        localAssetsOnly: false,
        health: buildHealth('invalid-folder', 'This folder name is not a valid managed HyperFrames project ID.'),
      });
      continue;
    }
    projects.push(await inspectHyperFramesProject(id, options));
  }
  projects.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  return { projects };
}

async function validateTemplate(templateId) {
  const { template, templateDir } = resolveTemplateDir(templateId);
  const entryPath = path.join(templateDir, PROJECT_ENTRY_FILE);
  if (!(await fs.pathExists(entryPath))) {
    throw new Error('That HyperFrames template is missing index.html.');
  }
  await inspectTreeSafety(templateDir, PROJECT_TREE_LIMITS);
  await scanStagedCompositionForRemoteReferences(templateDir, PROJECT_TREE_LIMITS);
  return { template, templateDir };
}

async function validateProjectCreationSource(sourceId) {
  if (sourceId === BLANK_PROJECT.id) {
    const sourceDir = getBlankProjectResourcesDir();
    const entryPath = path.join(sourceDir, PROJECT_ENTRY_FILE);
    if (!(await fs.pathExists(entryPath))) {
      throw new Error('The Blank Project scaffold is missing index.html. Reinstall Local AI Hub.');
    }
    await inspectTreeSafety(sourceDir, PROJECT_TREE_LIMITS);
    await scanStagedCompositionForRemoteReferences(sourceDir, PROJECT_TREE_LIMITS);
    return { source: BLANK_PROJECT, sourceDir };
  }
  const { template, templateDir } = await validateTemplate(sourceId);
  return { source: { ...template, sourceType: 'starter-template' }, sourceDir: templateDir };
}

async function createHyperFramesProject(payload = {}, options = {}) {
  return queueOperation(async () => {
    if (!options.managedRoot) {
      await ensureStorage();
    }
    const { source, sourceDir } = await validateProjectCreationSource(payload.templateId || BUILT_IN_TEMPLATES[0].id);
    const displayName = sanitizeDisplayName(payload.displayName, source.label);
    const projectId = createProjectId(displayName);
    const { projectDir, projectsRoot } = resolveProjectDir(projectId, options);
    await fs.ensureDir(projectsRoot);
    if (await fs.pathExists(projectDir)) {
      throw new Error('Local AI Hub could not create a unique HyperFrames project folder. Try again.');
    }
    await copyCompositionProjectSafely(sourceDir, projectDir, PROJECT_TREE_LIMITS);
    const manifest = buildProjectManifest({
      projectId,
      displayName,
      templateId: source.id,
      templateVersion: source.version,
      sourceType: source.sourceType,
      description: payload.description,
    });
    await writeJsonAtomic(getManifestPath(projectDir), manifest);
    return {
      message: 'HyperFrames project created.',
      project: await inspectHyperFramesProject(projectId, options),
    };
  });
}

async function renameHyperFramesProject(projectId, displayName, options = {}) {
  return queueOperation(async () => {
    const { projectDir, projectId: safeProjectId } = resolveProjectDir(projectId, options);
    const current = await inspectHyperFramesProject(safeProjectId, options);
    if (!current.health?.runnable) {
      throw new Error('Local AI Hub can only rename managed HyperFrames projects with a valid project manifest.');
    }
    const manifest = buildProjectManifest({
      ...current,
      displayName: sanitizeDisplayName(displayName, current.displayName),
      createdAt: current.createdAt,
    });
    await writeJsonAtomic(getManifestPath(projectDir), manifest);
    return {
      message: 'HyperFrames project renamed.',
      project: await inspectHyperFramesProject(safeProjectId, options),
    };
  });
}

async function duplicateHyperFramesProject(projectId, displayName, options = {}) {
  return queueOperation(async () => {
    const source = await inspectHyperFramesProject(projectId, options);
    if (!source.health?.runnable) {
      throw new Error('Local AI Hub can only duplicate a healthy managed HyperFrames project.');
    }
    const { projectDir: sourceDir } = resolveProjectDir(projectId, options);
    const nextName = sanitizeDisplayName(displayName, `${source.displayName} copy`);
    const nextProjectId = createProjectId(nextName);
    const { projectDir: targetDir, projectsRoot } = resolveProjectDir(nextProjectId, options);
    await fs.ensureDir(projectsRoot);
    await copyCompositionProjectSafely(sourceDir, targetDir, PROJECT_TREE_LIMITS);
    const manifest = buildProjectManifest({
      projectId: nextProjectId,
      displayName: nextName,
      templateId: source.templateId,
      templateVersion: source.templateVersion,
      sourceType: source.sourceType,
      description: source.description,
    });
    await writeJsonAtomic(getManifestPath(targetDir), manifest);
    return {
      message: 'HyperFrames project duplicated.',
      project: await inspectHyperFramesProject(nextProjectId, options),
    };
  });
}

async function deleteHyperFramesProject(projectId, options = {}) {
  return queueOperation(async () => {
    const { projectDir, projectsRoot, projectId: safeProjectId } = resolveProjectDir(projectId, options);
    if (!(await fs.pathExists(projectDir))) {
      return { message: 'That HyperFrames project was already gone.', deletedProjectId: safeProjectId };
    }
    await assertRealPathInside(projectsRoot, projectDir, 'Local AI Hub refused to delete a HyperFrames project outside managed storage.');
    await assertNoReparsePointTraversal(projectsRoot, projectDir, 'Local AI Hub refused to delete that HyperFrames project because it crosses a symlink or junction.');
    await inspectTreeSafety(projectDir, options.limits || PROJECT_TREE_LIMITS);
    await fs.remove(projectDir);
    return { message: 'HyperFrames project deleted.', deletedProjectId: safeProjectId };
  });
}

async function openHyperFramesProjectFolder(projectId, openPath, options = {}) {
  const { projectDir, projectsRoot, projectId: safeProjectId } = resolveProjectDir(projectId, options);
  if (!(await fs.pathExists(projectDir))) {
    throw new Error('That HyperFrames project folder no longer exists.');
  }
  await assertRealPathInside(projectsRoot, projectDir, 'Local AI Hub refused to open a HyperFrames project outside managed storage.');
  await assertNoReparsePointTraversal(projectsRoot, projectDir, 'Local AI Hub refused to open that HyperFrames project because it crosses a symlink or junction.');
  if (typeof openPath !== 'function') {
    return { message: 'HyperFrames project folder verified.', projectId: safeProjectId, projectDir };
  }
  const result = await openPath(projectDir);
  if (result) {
    throw new Error('Windows could not open that HyperFrames project folder.');
  }
  return { message: 'Opened the HyperFrames project folder.', projectId: safeProjectId };
}

function normalizeRelativePathSeparators(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function splitRelativeProjectPath(value, options = {}) {
  const normalized = normalizeRelativePathSeparators(value);
  if (!normalized && options.allowEmpty) return [];
  if (!normalized) {
    throw new Error('Choose a project file first.');
  }
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new Error('Local AI Hub accepts project-relative paths only for HyperFrames project editing.');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length && !options.allowEmpty) {
    throw new Error('Choose a project file first.');
  }
  for (const segment of segments) {
    validateSafePathSegment(segment);
    if (segment === '.' || segment === '..') {
      throw new Error('Local AI Hub refused to use a path traversal segment.');
    }
  }
  return segments;
}

function normalizeProjectRelativePath(value, options = {}) {
  const segments = splitRelativeProjectPath(value, options);
  return segments.join('/');
}

function validateSafePathSegment(value) {
  const segment = String(value || '');
  if (!segment.trim()) {
    throw new Error('Enter a file or folder name first.');
  }
  if (/[\\/:*?"<>|]/.test(segment) || /[\x00-\x1f]/.test(segment)) {
    throw new Error('Use a normal Windows file name without path separators or reserved characters.');
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    throw new Error('Windows file names cannot end with a dot or space.');
  }
  const lower = segment.toLowerCase();
  const base = lower.includes('.') ? lower.slice(0, lower.indexOf('.')) : lower;
  if (RESERVED_WINDOWS_DEVICE_NAMES.has(base)) {
    throw new Error('That file name is reserved by Windows. Choose a different name.');
  }
  if (segment === '.' || segment === '..') {
    throw new Error('Local AI Hub refused to use a path traversal segment.');
  }
  return segment;
}

function validateSafeFileName(value) {
  const rawName = String(value || '');
  const name = path.basename(rawName);
  if (name !== rawName) {
    throw new Error('Enter a file name only, without folders.');
  }
  return validateSafePathSegment(name);
}

function extensionForRelativePath(relativePath) {
  return path.extname(String(relativePath || '')).toLowerCase();
}

function isEditableProjectTextPath(relativePath) {
  const normalized = normalizeProjectRelativePath(relativePath);
  if (normalized.toLowerCase() === PROJECT_MANIFEST_FILE) return false;
  return EDITABLE_FILE_EXTENSIONS.includes(extensionForRelativePath(normalized));
}

function assertEditableProjectTextPath(relativePath) {
  const normalized = normalizeProjectRelativePath(relativePath);
  if (!isEditableProjectTextPath(normalized)) {
    throw new Error(`Local AI Hub can edit ${EDITABLE_FILE_EXTENSIONS.join(', ')} files in this first HyperFrames editor pass. project.json is managed by Local AI Hub.`);
  }
  return normalized;
}

function assertMutableProjectPath(relativePath, options = {}) {
  const normalized = normalizeProjectRelativePath(relativePath);
  const lower = normalized.toLowerCase();
  if (lower === PROJECT_MANIFEST_FILE) {
    throw new Error('Local AI Hub manages project.json automatically, so it cannot be edited or renamed here.');
  }
  if (options.blockEntrypoint !== false && lower === PROJECT_ENTRY_FILE) {
    throw new Error('index.html is the managed HyperFrames project entrypoint and cannot be deleted or renamed in this first editor pass.');
  }
  return normalized;
}

function shouldHideProjectEntry(name) {
  return BLOCKED_PROJECT_ENTRY_NAMES.has(String(name || '').trim().toLowerCase());
}

function hasBinaryBytes(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function validateLocalOnlyTextContent(content, relativePath = '') {
  const text = String(content || '');
  const findings = [];
  if (/https?:\/\//i.test(text)) findings.push('remote http/https references');
  if (/\bdata:/i.test(text)) findings.push('data URL references');
  if (/\.\.[\\/]\.\.[\\/]/.test(text)) findings.push('path escape references such as ..\\..\\');
  if (findings.length) {
    throw new Error(`${LOCAL_ONLY_POLICY_MESSAGE} Remove ${findings.join(', ')} from ${relativePath || 'this file'} before saving.`);
  }
}

async function resolveManagedProject(projectId, options = {}) {
  const { projectDir, projectsRoot, projectId: safeProjectId } = resolveProjectDir(projectId, options);
  if (!(await fs.pathExists(projectDir))) {
    throw new Error('That HyperFrames project no longer exists on this PC.');
  }
  await assertRealPathInside(projectsRoot, projectDir, 'Local AI Hub refused to use a HyperFrames project outside managed storage.');
  await assertNoReparsePointTraversal(projectsRoot, projectDir, 'Local AI Hub refused to use that HyperFrames project because it crosses a symlink or junction.');
  return { projectDir, projectsRoot, projectId: safeProjectId };
}

async function resolveProjectRelativeFile(projectId, relativePath, options = {}) {
  const project = await resolveManagedProject(projectId, options);
  const normalizedRelativePath = normalizeProjectRelativePath(relativePath);
  const targetPath = path.resolve(path.join(project.projectDir, ...normalizedRelativePath.split('/')));
  assertPathInside(project.projectDir, targetPath, 'Local AI Hub refused to use a file outside this managed HyperFrames project.');
  await assertRealPathInside(project.projectDir, targetPath, 'Local AI Hub refused to use that project file because it crosses a symlink or junction.');
  return { ...project, relativePath: normalizedRelativePath, targetPath };
}

async function resolveProjectRelativeParent(projectId, relativePath, options = {}) {
  const project = await resolveManagedProject(projectId, options);
  const normalizedRelativePath = normalizeProjectRelativePath(relativePath);
  const targetPath = path.resolve(path.join(project.projectDir, ...normalizedRelativePath.split('/')));
  const parentPath = path.dirname(targetPath);
  assertPathInside(project.projectDir, targetPath, 'Local AI Hub refused to use a file outside this managed HyperFrames project.');
  assertPathInside(project.projectDir, parentPath, 'Local AI Hub refused to use a folder outside this managed HyperFrames project.');
  await assertRealPathInside(project.projectDir, parentPath, 'Local AI Hub refused to use that project folder because it crosses a symlink or junction.');
  return { ...project, relativePath: normalizedRelativePath, targetPath, parentPath };
}

async function updateProjectModifiedTime(projectDir, projectId) {
  const manifestPath = getManifestPath(projectDir);
  const current = await fs.readJson(manifestPath).catch(() => null);
  if (!current) return null;
  const manifest = normalizeProjectManifest({ ...current, updatedAt: nowIso() }, { projectId });
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

function serializeProjectEntry(projectDir, currentPath, stats, kind) {
  const relativePath = path.relative(projectDir, currentPath).replace(/\\/g, '/');
  const extension = kind === 'file' ? extensionForRelativePath(relativePath) : '';
  return {
    kind,
    name: path.basename(currentPath),
    relativePath,
    sizeBytes: kind === 'file' ? Number(stats.size || 0) : 0,
    modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
    extension,
    editable: kind === 'file' && isEditableProjectTextPath(relativePath) && Number(stats.size || 0) <= MAX_EDITABLE_TEXT_FILE_BYTES,
    asset: kind === 'file' && relativePath.toLowerCase().startsWith(`${PROJECT_ASSETS_DIRECTORY}/`) && ASSET_FILE_EXTENSION_SET.has(extension),
  };
}

async function listProjectTreeEntries(projectDir, options = {}) {
  const limits = {
    maxDepth: Math.max(1, Number(options.maxDepth || PROJECT_FILE_BROWSER_LIMITS.maxDepth) || PROJECT_FILE_BROWSER_LIMITS.maxDepth),
    maxEntries: Math.max(1, Number(options.maxEntries || PROJECT_FILE_BROWSER_LIMITS.maxEntries) || PROJECT_FILE_BROWSER_LIMITS.maxEntries),
    maxTotalBytes: Math.max(1, Number(options.maxTotalBytes || PROJECT_FILE_BROWSER_LIMITS.maxTotalBytes) || PROJECT_FILE_BROWSER_LIMITS.maxTotalBytes),
  };
  const entries = [];
  const state = { totalBytes: 0 };
  async function visit(currentPath, depth) {
    if (depth > limits.maxDepth) {
      throw new Error('This HyperFrames project is deeper than Local AI Hub can safely list.');
    }
    const stats = await fs.lstat(currentPath);
    if ((typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) || (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())) {
      throw new Error('This HyperFrames project contains a symlink or junction. Local AI Hub will not browse through it.');
    }
    if (currentPath !== projectDir) {
      const name = path.basename(currentPath);
      if (shouldHideProjectEntry(name)) return;
      const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : '';
      if (!kind) return;
      entries.push(serializeProjectEntry(projectDir, currentPath, stats, kind));
      if (entries.length > limits.maxEntries) {
        throw new Error('This HyperFrames project has more files than Local AI Hub can safely list.');
      }
      if (stats.isFile()) {
        state.totalBytes += Number(stats.size || 0);
        if (state.totalBytes > limits.maxTotalBytes) {
          throw new Error('This HyperFrames project is larger than Local AI Hub can safely list.');
        }
      }
    }
    if (!stats.isDirectory()) return;
    const children = await fs.readdir(currentPath);
    for (const child of children.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      if (shouldHideProjectEntry(child)) continue;
      await visit(path.join(currentPath, child), depth + 1);
    }
  }
  await visit(projectDir, 0);
  return { entries, totalBytes: state.totalBytes };
}

async function listHyperFramesProjectFiles(projectId, options = {}) {
  const project = await resolveManagedProject(projectId, options);
  const [projectInfo, tree] = await Promise.all([
    inspectHyperFramesProject(project.projectId, options),
    listProjectTreeEntries(project.projectDir, options.limits || PROJECT_FILE_BROWSER_LIMITS),
  ]);
  return {
    files: tree.entries,
    limits: { ...PROJECT_FILE_BROWSER_LIMITS, maxEditableTextFileBytes: MAX_EDITABLE_TEXT_FILE_BYTES },
    project: projectInfo,
    totalBytes: tree.totalBytes,
  };
}

async function readHyperFramesProjectTextFile(projectId, relativePath, options = {}) {
  const editablePath = assertEditableProjectTextPath(relativePath);
  const resolved = await resolveProjectRelativeFile(projectId, editablePath, options);
  const stats = await fs.stat(resolved.targetPath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error('Local AI Hub could not find that project text file.');
  }
  if (stats.size > MAX_EDITABLE_TEXT_FILE_BYTES) {
    throw new Error(`That file is larger than Local AI Hub's ${Math.round(MAX_EDITABLE_TEXT_FILE_BYTES / 1024)} KB editor limit.`);
  }
  const buffer = await fs.readFile(resolved.targetPath);
  if (hasBinaryBytes(buffer)) {
    throw new Error('Local AI Hub will not open binary files in the HyperFrames text editor.');
  }
  const text = buffer.toString('utf8');
  return {
    content: text,
    editable: true,
    encoding: 'utf8',
    lineEnding: text.includes('\r\n') ? 'crlf' : 'lf',
    maxBytes: MAX_EDITABLE_TEXT_FILE_BYTES,
    modifiedAt: stats.mtime ? stats.mtime.toISOString() : null,
    relativePath: resolved.relativePath,
    sizeBytes: stats.size,
  };
}

function normalizeSavedTextContent(nextContent, previousContent = '') {
  const text = String(nextContent ?? '');
  if (String(previousContent || '').includes('\r\n')) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function saveHyperFramesProjectTextFile(projectId, relativePath, content, options = {}) {
  return queueOperation(async () => {
    const editablePath = assertEditableProjectTextPath(relativePath);
    validateLocalOnlyTextContent(content, editablePath);
    const resolved = await resolveProjectRelativeFile(projectId, editablePath, options);
    const stats = await fs.stat(resolved.targetPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw new Error('Local AI Hub could not find that project text file.');
    }
    if (stats.size > MAX_EDITABLE_TEXT_FILE_BYTES) {
      throw new Error(`That file is larger than Local AI Hub's ${Math.round(MAX_EDITABLE_TEXT_FILE_BYTES / 1024)} KB editor limit.`);
    }
    const previousBuffer = await fs.readFile(resolved.targetPath);
    if (hasBinaryBytes(previousBuffer)) {
      throw new Error('Local AI Hub will not save over binary files from the HyperFrames text editor.');
    }
    const nextText = normalizeSavedTextContent(content, previousBuffer.toString('utf8'));
    const nextBuffer = Buffer.from(nextText, 'utf8');
    if (nextBuffer.length > MAX_EDITABLE_TEXT_FILE_BYTES) {
      throw new Error(`That edit is larger than Local AI Hub's ${Math.round(MAX_EDITABLE_TEXT_FILE_BYTES / 1024)} KB editor limit.`);
    }
    const tempPath = `${resolved.targetPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, nextBuffer);
    await fs.move(tempPath, resolved.targetPath, { overwrite: true });
    await updateProjectModifiedTime(resolved.projectDir, resolved.projectId);
    const health = await getHyperFramesProjectHealth(resolved.projectId, options);
    return {
      file: await readHyperFramesProjectTextFile(resolved.projectId, editablePath, options),
      health,
      message: 'HyperFrames project file saved.',
    };
  });
}

async function createHyperFramesProjectTextFile(projectId, relativePath, content = '', options = {}) {
  return queueOperation(async () => {
    const editablePath = assertEditableProjectTextPath(validateSafeFileName(relativePath));
    validateLocalOnlyTextContent(content, editablePath);
    const resolved = await resolveProjectRelativeParent(projectId, editablePath, options);
    const nextBuffer = Buffer.from(String(content ?? ''), 'utf8');
    if (nextBuffer.length > MAX_NEW_TEXT_FILE_BYTES) {
      throw new Error(`New HyperFrames text files must be ${Math.round(MAX_NEW_TEXT_FILE_BYTES / 1024)} KB or smaller.`);
    }
    const target = await nextAvailableProjectPath(resolved.projectDir, editablePath);
    assertPathInside(resolved.parentPath, path.dirname(target.candidatePath), 'Local AI Hub refused to create a HyperFrames text file outside the requested project folder.');
    await fs.ensureDir(path.dirname(target.candidatePath));
    await fs.writeFile(target.candidatePath, nextBuffer);
    await updateProjectModifiedTime(resolved.projectDir, resolved.projectId);
    return {
      file: await readHyperFramesProjectTextFile(resolved.projectId, target.candidateRelative, options),
      message: target.candidateRelative === editablePath
        ? 'HyperFrames project file created.'
        : `HyperFrames project file created as ${target.candidateRelative} because that name already existed.`,
    };
  });
}

async function renameHyperFramesProjectFile(projectId, relativePath, newName, options = {}) {
  return queueOperation(async () => {
    const sourceRelativePath = assertMutableProjectPath(relativePath);
    const safeName = validateSafeFileName(newName);
    const source = await resolveProjectRelativeFile(projectId, sourceRelativePath, options);
    const targetRelativePath = normalizeProjectRelativePath([...sourceRelativePath.split('/').slice(0, -1), safeName].filter(Boolean).join('/'));
    assertMutableProjectPath(targetRelativePath);
    const target = await resolveProjectRelativeParent(projectId, targetRelativePath, options);
    if (await fs.pathExists(target.targetPath)) {
      throw new Error('A project file with that name already exists.');
    }
    await fs.move(source.targetPath, target.targetPath, { overwrite: false });
    await updateProjectModifiedTime(source.projectDir, source.projectId);
    return { message: 'HyperFrames project file renamed.', relativePath: targetRelativePath };
  });
}

function buildDuplicateName(fileName) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension);
  return `${base} copy${extension}`;
}

async function nextAvailableProjectPath(projectDir, preferredRelativePath) {
  const normalized = normalizeProjectRelativePath(preferredRelativePath);
  const dir = path.dirname(normalized).replace(/\\/g, '/');
  const name = path.basename(normalized);
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? name : `${base} (${index + 1})${extension}`;
    const candidateRelative = normalizeProjectRelativePath([dir === '.' ? '' : dir, candidateName].filter(Boolean).join('/'));
    const candidatePath = path.resolve(path.join(projectDir, ...candidateRelative.split('/')));
    assertPathInside(projectDir, candidatePath, 'Local AI Hub refused to create a duplicate outside this HyperFrames project.');
    if (!(await fs.pathExists(candidatePath))) return { candidatePath, candidateRelative };
  }
  throw new Error('Local AI Hub could not find a safe duplicate file name.');
}

async function duplicateHyperFramesProjectFile(projectId, relativePath, newName = '', options = {}) {
  return queueOperation(async () => {
    const sourceRelativePath = assertMutableProjectPath(relativePath, { blockEntrypoint: false });
    const source = await resolveProjectRelativeFile(projectId, sourceRelativePath, options);
    const stats = await fs.stat(source.targetPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw new Error('Local AI Hub can duplicate files in this first HyperFrames editor pass.');
    }
    const targetName = newName ? validateSafeFileName(newName) : buildDuplicateName(path.basename(sourceRelativePath));
    const preferredRelativePath = [...sourceRelativePath.split('/').slice(0, -1), targetName].filter(Boolean).join('/');
    const target = await nextAvailableProjectPath(source.projectDir, preferredRelativePath);
    await fs.copyFile(source.targetPath, target.candidatePath);
    await updateProjectModifiedTime(source.projectDir, source.projectId);
    return { message: 'HyperFrames project file duplicated.', relativePath: target.candidateRelative };
  });
}

async function deleteHyperFramesProjectFile(projectId, relativePath, options = {}) {
  return queueOperation(async () => {
    const sourceRelativePath = assertMutableProjectPath(relativePath);
    const source = await resolveProjectRelativeFile(projectId, sourceRelativePath, options);
    const stats = await fs.stat(source.targetPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw new Error('Local AI Hub can delete project files in this first HyperFrames editor pass.');
    }
    await fs.remove(source.targetPath);
    await updateProjectModifiedTime(source.projectDir, source.projectId);
    return { message: 'HyperFrames project file deleted.', deletedRelativePath: sourceRelativePath };
  });
}

function assertAssetRelativePath(relativePath, options = {}) {
  const normalized = normalizeProjectRelativePath(relativePath, options);
  if (!normalized && options.allowEmpty) return '';
  const lower = normalized.toLowerCase();
  if (lower !== PROJECT_ASSETS_DIRECTORY && !lower.startsWith(`${PROJECT_ASSETS_DIRECTORY}/`)) {
    throw new Error('HyperFrames project asset actions are limited to the project assets folder.');
  }
  return normalized;
}

async function listHyperFramesProjectAssets(projectId, options = {}) {
  const project = await resolveManagedProject(projectId, options);
  const assetsDir = path.join(project.projectDir, PROJECT_ASSETS_DIRECTORY);
  await fs.ensureDir(assetsDir);
  await assertRealPathInside(project.projectDir, assetsDir, 'Local AI Hub refused to list assets through a symlink or junction.');
  const tree = await listProjectTreeEntries(assetsDir, {
    ...(options.limits || PROJECT_FILE_BROWSER_LIMITS),
    maxDepth: Math.min(PROJECT_FILE_BROWSER_LIMITS.maxDepth, Number(options.limits?.maxDepth || PROJECT_FILE_BROWSER_LIMITS.maxDepth) || PROJECT_FILE_BROWSER_LIMITS.maxDepth),
  });
  const assets = tree.entries.map((entry) => ({
    ...entry,
    relativePath: `${PROJECT_ASSETS_DIRECTORY}/${entry.relativePath}`.replace(/\/+/g, '/'),
    reference: `${PROJECT_ASSETS_DIRECTORY}/${entry.relativePath}`.replace(/\/+/g, '/'),
    supported: entry.kind === 'directory' || ASSET_FILE_EXTENSION_SET.has(entry.extension),
  }));
  return {
    assets,
    allowedExtensions: ASSET_FILE_EXTENSIONS,
    limits: { maxAssetFileBytes: MAX_ASSET_FILE_BYTES, maxProjectTotalBytes: MAX_PROJECT_TOTAL_BYTES },
    project: await inspectHyperFramesProject(project.projectId, options),
  };
}

function validateAssetExtension(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!ASSET_FILE_EXTENSION_SET.has(extension)) {
    throw new Error(`Local AI Hub can copy only these asset types into HyperFrames projects: ${ASSET_FILE_EXTENSIONS.join(', ')}.`);
  }
  return extension;
}

async function getProjectTotalBytes(projectDir) {
  let total = 0;
  async function visit(currentPath) {
    const stats = await fs.lstat(currentPath);
    if ((typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) || (typeof stats.isReparsePoint === 'function' && stats.isReparsePoint())) {
      throw new Error('This HyperFrames project contains a symlink or junction.');
    }
    if (stats.isDirectory()) {
      const children = await fs.readdir(currentPath);
      for (const child of children) await visit(path.join(currentPath, child));
      return;
    }
    if (stats.isFile()) total += Number(stats.size || 0);
  }
  await visit(projectDir);
  return total;
}

async function importHyperFramesProjectAssets(projectId, payload = {}, options = {}) {
  return queueOperation(async () => {
    const sourceFiles = Array.isArray(payload?.sourceFiles || payload?.files) ? (payload.sourceFiles || payload.files) : [];
    if (!sourceFiles.length) {
      throw new Error('Choose at least one local asset file to copy into the HyperFrames project.');
    }
    const targetSubfolder = normalizeProjectRelativePath(payload?.targetSubfolder || PROJECT_ASSETS_DIRECTORY, { allowEmpty: true }) || PROJECT_ASSETS_DIRECTORY;
    const targetFolderRelative = assertAssetRelativePath(targetSubfolder === PROJECT_ASSETS_DIRECTORY ? PROJECT_ASSETS_DIRECTORY : targetSubfolder);
    const project = await resolveManagedProject(projectId, options);
    const assetsDir = path.join(project.projectDir, PROJECT_ASSETS_DIRECTORY);
    const targetDir = path.resolve(path.join(project.projectDir, ...targetFolderRelative.split('/')));
    assertPathInside(assetsDir, targetDir, 'Local AI Hub refused to copy assets outside this project assets folder.');
    await fs.ensureDir(targetDir);
    await assertRealPathInside(project.projectDir, targetDir, 'Local AI Hub refused to copy assets through a symlink or junction.');
    const imported = [];
    let currentTotalBytes = await getProjectTotalBytes(project.projectDir);
    for (const sourceFile of sourceFiles) {
      const sourcePath = path.resolve(String(sourceFile || '').trim());
      const extension = validateAssetExtension(sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error('Local AI Hub could not find one of the selected asset files anymore.');
      }
      const stats = await fs.stat(sourcePath);
      if (!stats.isFile()) {
        throw new Error('Local AI Hub can copy asset files, not folders, into HyperFrames projects.');
      }
      if (stats.size > MAX_ASSET_FILE_BYTES) {
        throw new Error(`Each HyperFrames project asset must be ${Math.round(MAX_ASSET_FILE_BYTES / (1024 * 1024))} MB or smaller.`);
      }
      if (currentTotalBytes + Number(stats.size || 0) > MAX_PROJECT_TOTAL_BYTES) {
        throw new Error(`This project would exceed Local AI Hub's ${Math.round(MAX_PROJECT_TOTAL_BYTES / (1024 * 1024))} MB managed project size limit.`);
      }
      const safeBase = path.basename(sourcePath, extension).replace(/[^a-zA-Z0-9._ -]+/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'asset';
      const safeName = validateSafeFileName(`${safeBase}${extension}`);
      const preferredRelative = `${targetFolderRelative}/${safeName}`;
      const target = await nextAvailableProjectPath(project.projectDir, preferredRelative);
      assertPathInside(assetsDir, target.candidatePath, 'Local AI Hub refused to copy assets outside this project assets folder.');
      await fs.copy(sourcePath, target.candidatePath, { overwrite: false, errorOnExist: true });
      currentTotalBytes += Number(stats.size || 0);
      imported.push({
        name: path.basename(target.candidateRelative),
        relativePath: target.candidateRelative,
        reference: target.candidateRelative.replace(/\\/g, '/'),
        sizeBytes: Number(stats.size || 0),
        extension,
      });
    }
    await updateProjectModifiedTime(project.projectDir, project.projectId);
    return { assets: imported, assetList: await listHyperFramesProjectAssets(project.projectId, options), message: 'Assets copied into the managed HyperFrames project.' };
  });
}

async function renameHyperFramesProjectAsset(projectId, relativePath, newName, options = {}) {
  assertAssetRelativePath(relativePath);
  return renameHyperFramesProjectFile(projectId, relativePath, newName, options);
}

async function duplicateHyperFramesProjectAsset(projectId, relativePath, newName = '', options = {}) {
  assertAssetRelativePath(relativePath);
  return duplicateHyperFramesProjectFile(projectId, relativePath, newName, options);
}

async function deleteHyperFramesProjectAsset(projectId, relativePath, options = {}) {
  assertAssetRelativePath(relativePath);
  return deleteHyperFramesProjectFile(projectId, relativePath, options);
}

function getHyperFramesProjectAssetReference(relativePath) {
  const normalized = assertAssetRelativePath(relativePath);
  return { reference: normalized.replace(/\\/g, '/'), relativePath: normalized };
}

async function getHyperFramesProjectHealth(projectId, options = {}) {
  const project = await resolveManagedProject(projectId, options);
  const details = {
    bounds: { ok: false, fileCount: 0, totalBytes: 0 },
    damaged: [],
    entrypointExists: false,
    lastModifiedAt: null,
    localOnly: false,
    manifestValid: false,
    manifestStatus: 'unknown',
    unsupportedAssets: [],
    unsafePaths: [],
  };
  const manifestResult = await readManifestForProject(project.projectDir, project.projectId);
  details.manifestValid = Boolean(manifestResult.manifest);
  details.manifestStatus = manifestResult.health?.status || 'valid';
  details.lastModifiedAt = manifestResult.manifest?.updatedAt || null;
  details.entrypointExists = await fs.pathExists(path.join(project.projectDir, PROJECT_ENTRY_FILE));
  if (!details.entrypointExists) details.damaged.push(PROJECT_ENTRY_FILE);
  try {
    const tree = await listProjectTreeEntries(project.projectDir, options.limits || PROJECT_FILE_BROWSER_LIMITS);
    details.bounds = { ok: true, fileCount: tree.entries.filter((entry) => entry.kind === 'file').length, totalBytes: tree.totalBytes };
    details.unsupportedAssets = tree.entries
      .filter((entry) => entry.kind === 'file' && entry.relativePath.toLowerCase().startsWith(`${PROJECT_ASSETS_DIRECTORY}/`) && !ASSET_FILE_EXTENSION_SET.has(entry.extension))
      .map((entry) => entry.relativePath)
      .slice(0, 20);
  } catch (error) {
    details.unsafePaths.push(error?.message || 'Local AI Hub could not safely inspect this project tree.');
  }
  try {
    await scanStagedCompositionForRemoteReferences(project.projectDir, options.limits || PROJECT_TREE_LIMITS);
    details.localOnly = true;
  } catch (error) {
    details.localOnly = false;
    details.damaged.push(error?.code === 'HYPERFRAMES_REMOTE_REFERENCE' ? 'remote-or-data-reference' : 'local-only-scan');
  }
  const runnable = details.manifestValid && details.entrypointExists && details.localOnly && details.bounds.ok && !details.unsupportedAssets.length && !details.unsafePaths.length;
  return {
    ...details,
    message: runnable
      ? 'This managed HyperFrames project passes the editor health checks.'
      : 'This project needs attention before rendering. Local AI Hub did not execute or preview the composition while checking it.',
    runnable,
    status: runnable ? 'healthy' : 'needs-attention',
  };
}

async function getHyperFramesProjectEditorState(projectId, options = {}) {
  const [project, files, assets, health] = await Promise.all([
    inspectHyperFramesProject(projectId, options),
    listHyperFramesProjectFiles(projectId, options),
    listHyperFramesProjectAssets(projectId, options),
    getHyperFramesProjectHealth(projectId, options),
  ]);
  return {
    allowedAssetExtensions: ASSET_FILE_EXTENSIONS,
    allowedEditableExtensions: EDITABLE_FILE_EXTENSIONS,
    assets: assets.assets,
    files: files.files,
    health,
    limits: {
      maxAssetFileBytes: MAX_ASSET_FILE_BYTES,
      maxEditableTextFileBytes: MAX_EDITABLE_TEXT_FILE_BYTES,
      maxProjectTotalBytes: MAX_PROJECT_TOTAL_BYTES,
      tree: PROJECT_FILE_BROWSER_LIMITS,
    },
    project,
  };
}
async function prepareHyperFramesProjectForPipeline(projectId, options = {}) {
  const project = await inspectHyperFramesProject(projectId, options);
  if (!project.health?.runnable) {
    throw new Error(project.health?.message || 'This HyperFrames project is not ready to use in a pipeline.');
  }
  const { projectDir } = resolveProjectDir(project.projectId, options);
  const entryPath = path.join(projectDir, PROJECT_ENTRY_FILE);
  const artifact = await buildFileArtifact(entryPath, {
    displayName: project.displayName,
    kind: 'file',
    role: 'input',
  });
  artifact.hyperFramesProject = {
    projectId: project.projectId,
    displayName: project.displayName,
    templateId: project.templateId,
    templateVersion: project.templateVersion,
    sourceType: project.sourceType,
    entryFile: PROJECT_ENTRY_FILE,
    localAssetsOnly: true,
    trustedManagedProject: true,
  };
  return {
    artifact,
    message: 'Prepared the managed HyperFrames project for the pipeline.',
    project,
  };
}

async function buildHyperFramesProjectPipelineDraft(projectId, options = {}) {
  const prepared = await prepareHyperFramesProjectForPipeline(projectId, options);
  const project = prepared.project;
  const inputNode = createNode('hyperframesProjectInput', {
    id: 'hyperframes-project-input',
    label: 'HyperFrames Project Input',
    position: { x: 120, y: 220 },
    config: { projectId: project.projectId },
  });
  const renderNode = createNode('hyperframesRender', {
    id: 'hyperframes-render',
    label: 'HyperFrames Render',
    position: { x: 450, y: 220 },
    config: { fps: 30, quality: 'draft', workers: 1, browserGpu: false, format: 'mp4' },
  });
  const outputNode = createNode('videoOutput', {
    id: 'hyperframes-video-output',
    label: 'Video Output',
    position: { x: 780, y: 220 },
    config: { title: `${project.displayName} render` },
  });
  const pipeline = createEmptyPipeline({
    name: `${project.displayName} HyperFrames Render`,
    description: 'Render a managed local HyperFrames project to MP4.',
    nodes: [inputNode, renderNode, outputNode],
    edges: [
      createEdge(inputNode.id, 'project', renderNode.id, 'project', { id: 'hyperframes-project-to-render' }),
      createEdge(renderNode.id, 'video', outputNode.id, 'video', { id: 'hyperframes-render-to-output' }),
    ],
  });
  return {
    message: 'Created a draft pipeline for this HyperFrames project. Review it before running.',
    pipeline,
    project,
  };
}

module.exports = {
  ASSET_FILE_EXTENSIONS,
  BLANK_PROJECT,
  BUILT_IN_TEMPLATES,
  EDITABLE_FILE_EXTENSIONS,
  LOCAL_ONLY_POLICY_MESSAGE,
  MAX_ASSET_FILE_BYTES,
  MAX_EDITABLE_TEXT_FILE_BYTES,
  MAX_PROJECT_TOTAL_BYTES,
  PROJECT_ASSETS_DIRECTORY,
  PROJECT_CREATED_BY,
  PROJECT_ENTRY_FILE,
  PROJECT_FILE_BROWSER_LIMITS,
  PROJECT_MANIFEST_FILE,
  PROJECT_SCHEMA_VERSION,
  PROJECT_TREE_LIMITS,
  buildHyperFramesProjectPipelineDraft,
  createHyperFramesProject,
  createHyperFramesProjectTextFile,
  deleteHyperFramesProject,
  deleteHyperFramesProjectAsset,
  deleteHyperFramesProjectFile,
  duplicateHyperFramesProject,
  duplicateHyperFramesProjectAsset,
  duplicateHyperFramesProjectFile,
  getHyperFramesProjectAssetReference,
  getHyperFramesProjectEditorState,
  getHyperFramesProjectHealth,
  getBlankProjectResourcesDir,
  getHyperFramesProjectsRoot,
  getTemplateResourcesRoot,
  importHyperFramesProjectAssets,
  inspectHyperFramesProject,
  listHyperFramesProjectAssets,
  listHyperFramesProjectFiles,
  listHyperFramesProjectTemplates,
  listHyperFramesProjects,
  openHyperFramesProjectFolder,
  prepareHyperFramesProjectForPipeline,
  readHyperFramesProjectTextFile,
  renameHyperFramesProject,
  renameHyperFramesProjectAsset,
  renameHyperFramesProjectFile,
  saveHyperFramesProjectTextFile,
  validateLocalOnlyTextContent,
  validateProjectCreationSource,
  validateTemplate,
};
