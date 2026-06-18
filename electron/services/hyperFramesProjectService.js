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
  const createdAt = source.createdAt || nowIso();
  const updatedAt = source.updatedAt || createdAt;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    displayName: sanitizeDisplayName(source.displayName, 'Untitled HyperFrames Project'),
    templateId,
    templateVersion: Math.max(1, Number(source.templateVersion || template?.version || 1) || 1),
    entryFile: PROJECT_ENTRY_FILE,
    createdAt,
    updatedAt,
    localAssetsOnly: true,
    appCreated: true,
    createdBy: PROJECT_CREATED_BY,
    ...(sanitizeDescription(source.description) ? { description: sanitizeDescription(source.description) } : {}),
  };
}

function buildProjectManifest({ projectId, displayName, templateId, templateVersion, description, createdAt }) {
  const now = nowIso();
  return normalizeProjectManifest({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    displayName,
    templateId,
    templateVersion,
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
    localAssetsOnly: false,
    createdAt: null,
    updatedAt: null,
    description: '',
  };
  if (manifestResult.health) {
    return {
      ...fallbackManifest,
      templateLabel: BUILT_IN_TEMPLATE_BY_ID.get(fallbackManifest.templateId)?.label || 'Unknown',
      health: manifestResult.health,
    };
  }

  const entryPath = path.join(projectDir, PROJECT_ENTRY_FILE);
  if (!(await fs.pathExists(entryPath))) {
    return {
      ...fallbackManifest,
      templateLabel: BUILT_IN_TEMPLATE_BY_ID.get(fallbackManifest.templateId)?.label || 'Unknown',
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
      templateLabel: BUILT_IN_TEMPLATE_BY_ID.get(fallbackManifest.templateId)?.label || 'Unknown',
      health: buildHealth('healthy', 'This managed HyperFrames project is ready for the pipeline.', true, {
        scannedFileCount: scan.scannedFileCount,
        scannedExtensions: scan.scannedExtensions,
      }),
    };
  } catch (error) {
    return {
      ...fallbackManifest,
      templateLabel: BUILT_IN_TEMPLATE_BY_ID.get(fallbackManifest.templateId)?.label || 'Unknown',
      health: buildHealth(error?.code === 'HYPERFRAMES_REMOTE_REFERENCE' ? 'remote-references' : 'unsafe-project', error?.message || HYPERFRAMES_LOCAL_ASSETS_ERROR),
    };
  }
}

async function listHyperFramesProjectTemplates() {
  return {
    templates: BUILT_IN_TEMPLATES.map((template) => ({ ...template, localAssetsOnly: true })),
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

async function createHyperFramesProject(payload = {}, options = {}) {
  return queueOperation(async () => {
    if (!options.managedRoot) {
      await ensureStorage();
    }
    const { template, templateDir } = await validateTemplate(payload.templateId || BUILT_IN_TEMPLATES[0].id);
    const displayName = sanitizeDisplayName(payload.displayName, template.label);
    const projectId = createProjectId(displayName);
    const { projectDir, projectsRoot } = resolveProjectDir(projectId, options);
    await fs.ensureDir(projectsRoot);
    if (await fs.pathExists(projectDir)) {
      throw new Error('Local AI Hub could not create a unique HyperFrames project folder. Try again.');
    }
    await copyCompositionProjectSafely(templateDir, projectDir, PROJECT_TREE_LIMITS);
    const manifest = buildProjectManifest({
      projectId,
      displayName,
      templateId: template.id,
      templateVersion: template.version,
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
  BUILT_IN_TEMPLATES,
  PROJECT_CREATED_BY,
  PROJECT_ENTRY_FILE,
  PROJECT_MANIFEST_FILE,
  PROJECT_SCHEMA_VERSION,
  PROJECT_TREE_LIMITS,
  buildHyperFramesProjectPipelineDraft,
  createHyperFramesProject,
  deleteHyperFramesProject,
  duplicateHyperFramesProject,
  getHyperFramesProjectsRoot,
  getTemplateResourcesRoot,
  inspectHyperFramesProject,
  listHyperFramesProjectTemplates,
  listHyperFramesProjects,
  openHyperFramesProjectFolder,
  prepareHyperFramesProjectForPipeline,
  renameHyperFramesProject,
  validateTemplate,
};
