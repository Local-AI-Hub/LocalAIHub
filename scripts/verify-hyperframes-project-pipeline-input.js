const assert = require('assert');
const fs = require('fs');
const path = require('path');

const schema = require('../electron/shared/pipelineSchema.cjs');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function main() {
  const node = schema.getNodeTypeDefinition('hyperframesProjectInput');
  assert(node, 'HyperFrames Project Input node is registered');
  assert.strictEqual(node.category, 'Inputs', 'project input lives in Inputs');
  assert.deepStrictEqual(node.inputPorts, [], 'project input has no inbound ports');
  assert.strictEqual(node.outputPorts.length, 1, 'project input has one output');
  assert.strictEqual(node.outputPorts[0].id, 'project', 'project input output port is project');
  assert.strictEqual(node.outputPorts[0].kind, schema.PORT_KIND_FILE, 'project input emits file artifacts');
  assert.deepStrictEqual(Object.keys(node.configDefaults), ['projectId'], 'project input config only stores projectId');
  assert(!Object.prototype.hasOwnProperty.call(node.configDefaults, 'filePath'), 'project input has no arbitrary file path field');

  const outputNode = schema.createNode('fileOutput', { id: 'file-output' });
  const pipeline = schema.createEmptyPipeline({
    nodes: [schema.createNode('hyperframesProjectInput', { id: 'project-input', config: { projectId: '' } }), outputNode],
    edges: [schema.createEdge('project-input', 'project', 'file-output', 'file')],
  });
  const missingAnalysis = schema.analyzePipeline(pipeline, {});
  assert(missingAnalysis.issues.some((issue) => /Choose a managed HyperFrames project/i.test(issue.message)), 'analysis rejects missing project id');
  const readyPipeline = schema.createEmptyPipeline({
    nodes: [schema.createNode('hyperframesProjectInput', { id: 'project-input', config: { projectId: 'sample-project' } }), outputNode],
    edges: [schema.createEdge('project-input', 'project', 'file-output', 'file')],
  });
  const readyAnalysis = schema.analyzePipeline(readyPipeline, {});
  assert(!readyAnalysis.issues.some((issue) => /Choose a managed HyperFrames project/i.test(issue.message)), 'analysis accepts selected project id');

  const executionService = read('electron/services/pipelineExecutionService.js');
  assert(executionService.includes("prepareHyperFramesProjectForPipeline"), 'pipeline execution imports project preparation');
  assert(executionService.includes("node.type === 'hyperframesProjectInput'"), 'pipeline execution handles project input nodes');
  assert(executionService.includes('outputs: {\r\n        project: artifact') || executionService.includes('outputs: {\n        project: artifact'), 'project input emits project output artifact');

  const projectService = read('electron/services/hyperFramesProjectService.js');
  assert(projectService.includes('buildHyperFramesProjectPipelineDraft'), 'project service builds draft pipeline');
  assert(projectService.includes("createNode('hyperframesProjectInput'"), 'draft starts with HyperFrames Project Input');
  assert(projectService.includes("createNode('hyperframesRender'"), 'draft includes HyperFrames Render');
  assert(projectService.includes("createNode('videoOutput'"), 'draft includes Video Output');
  assert(projectService.includes('shell.openPath') === false, 'project service does not open arbitrary paths directly');

  const main = read('electron/main.js');
  assert(main.includes("hyperframes-projects:list"), 'main exposes project list IPC');
  assert(main.includes("hyperframes-projects:create"), 'main exposes project create IPC');
  assert(main.includes("hyperframes-projects:rename"), 'main exposes project rename IPC');
  assert(main.includes("hyperframes-projects:duplicate"), 'main exposes project duplicate IPC');
  assert(main.includes("hyperframes-projects:delete"), 'main exposes project delete IPC');
  assert(main.includes("hyperframes-projects:open-folder"), 'main exposes project open-folder IPC');
  assert(main.includes('openHyperFramesProjectFolder') && main.includes('shell.openPath(targetPath)'), 'open-folder IPC resolves project id before shell.openPath');

  const preload = read('electron/preload.js');
  for (const method of [
    'createHyperFramesProject',
    'deleteHyperFramesProject',
    'duplicateHyperFramesProject',
    'getHyperFramesProject',
    'listHyperFramesProjects',
    'listHyperFramesProjectTemplates',
    'openHyperFramesProjectFolder',
    'prepareHyperFramesProjectPipeline',
    'renameHyperFramesProject',
  ]) {
    assert(preload.includes(method), `preload exposes ${method}`);
  }

  const panel = read('src/components/PipelineBuilderPanel.jsx');
  const manager = read('src/components/HyperFramesProjectManager.jsx');
  assert(panel.includes("data-pipeline-resource-section=\"hyperframes-projects\""), 'UI places projects in pipeline resources');
  assert(panel.includes('HyperFramesProjectManager'), 'UI lazy-loads project manager');
  assert(panel.includes('window.confirm') && panel.includes('Replace the current pipeline draft'), 'Use in Pipeline confirms before replacing current draft');
  assert(panel.includes("selectedNode.type === 'hyperframesProjectInput'"), 'inspector has project input controls');
  assert(panel.includes('does not accept arbitrary folder paths'), 'inspector explains no arbitrary folder paths');
  assert(manager.includes('Projects are stored under Local AI Hub managed storage and remain available if HyperFrames is repaired or reinstalled.'), 'manager includes storage lifecycle note');
  assert(manager.includes('HyperFrames projects can execute HTML/CSS/JavaScript when rendered. Open and render only projects you trust.'), 'manager includes trusted code warning');
  assert(manager.includes('This version provides project management and templates. In-app editing and preview come later.'), 'manager includes no-editor note');
  assert(manager.includes('Create Project'), 'manager supports create action');
  assert(manager.includes('Use in Pipeline'), 'manager supports pipeline handoff');
  assert(manager.includes('Open Project Folder'), 'manager supports safe open-folder action');
  assert(manager.includes('Rename') && manager.includes('Duplicate') && manager.includes('Delete'), 'manager supports rename duplicate delete actions');
  assert(!manager.includes('showOpenDialog'), 'manager does not implement arbitrary folder import');
  assert(!manager.includes('Monaco') && !manager.includes('openPreview') && !manager.includes('PreviewPlayer') && !manager.includes('Studio'), 'manager does not implement editor or preview features');

  const config = read('electron/services/configService.js');
  assert(config.includes("'projects'"), 'managed data subdirectories include projects for migration');
  assert(config.includes('projectsRoot'), 'app paths expose projectsRoot');

  console.log('verify-hyperframes-project-pipeline-input: ok');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
