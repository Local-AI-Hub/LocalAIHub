const string = { type: 'string', minLength: 1, maxLength: 200 };
const definition = { type: 'object', description: 'Complete pipeline definition. Set runSettings.outputFolder to group this run’s final outputs in an existing or new named folder. Discover node defaults and ports with hub_node_types and hub_create_draft first.' };
function tool(name, description, properties = {}, required = [], mutating = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !mutating, destructiveHint: mutating, idempotentHint: !mutating, openWorldHint: true } };
}
const TOOLS = [
  tool('hub_deliver_media', 'Deliver a saved audio/video file: link mode returns expiring playback/download URLs usable on the Hub PC, not uploaded attachments. Audio mode returns audio bytes up to 700 KB; playback depends on client support. Links expire after 30 minutes and are revoked when agent access stops.', { outputId: string, mode: { ...string, enum: ['link', 'audio'] } }, ['outputId']),
  tool('hub_discovery', 'Discover configured provider capabilities, saved prompt/workflow presets, starter templates, asset library item IDs and HyperFrames project IDs. Does not contact cloud providers.', { section: { ...string, enum: ['providers', 'presets', 'templates', 'assetLibraries', 'hyperframesProjects'] } }, ['section']),
  tool('hub_import_hyperframes_project', 'Copy a local folder containing index.html into a new managed HyperFrames project. Returns its project ID for HyperFrames Project Input.', { folderPath: { ...string, maxLength: 2048 }, displayName: string }, ['folderPath'], true),
  tool('hub_inspect_media', 'Inspect saved image, audio or video metadata. Optionally return a JPEG preview of an image or one video frame for visual inspection. No audio playback.', { outputId: string, preview: { type: 'boolean' }, timeSeconds: { type: 'number', minimum: 0, maximum: 86400 } }, ['outputId']),
  tool('hub_diagnostics', 'Get bounded redacted tool output, including active HyperFrames render progress and recent failures. For additional reference findings use nextReferenceOffset.', { toolId: string, referenceOffset: {type:'integer', minimum:0, maximum:10000000}, maxChars: { type: 'integer', minimum: 256, maximum: 16384 } }, ['toolId']),
  tool('hub_tool_action', 'Start or stop an installed tool as a background job. Blocked while a pipeline runs or another lifecycle action is pending. Launches are headless and may take minutes. Reuse requestId on retries. Poll hub_job_status.', { toolId: string, action: { ...string, enum: ['launch', 'stop'] }, requestId: string }, ['toolId', 'action', 'requestId'], true),
  tool('hub_model_manager', 'Discover installed Model Manager targets, supported sources and filters, system hardware and drive space.'),
  tool('hub_model_search', 'Search a target catalog. Get selection IDs and artifact choices. Repeat the query with nextPage or nextCursor for more results.', { toolId: string, source: string, query: string, includeIncompatible: { type: 'boolean', description: 'Include blocked repositories in RVC and Upscayl searches.' }, modelType: string, taskType: string, sort: { ...string, enum: ['most-downloaded', 'newest', 'highest-rated'] }, page: { type: 'integer', minimum: 1, maximum: 1000000 }, cursor: { ...string, maxLength: 8192 } }, ['toolId']),
  tool('hub_model_preflight', 'Check space and destination for an exact catalog selection. Omit choiceIndex to use the recommended artifact.', { selectionId: string, choiceIndex: { type: 'integer', minimum: 0, maximum: 1000000 } }, ['selectionId']),
  tool('hub_model_install', 'Install a catalog selection. Poll hub_job_status. Reuse requestId on retry. Set lowDiskConfirmed only after confirming the low-space warning.', { selectionId: string, choiceIndex: { type: 'integer', minimum: 0, maximum: 1000000 }, lowDiskConfirmed: { type: 'boolean' }, requestId: string }, ['selectionId', 'requestId'], true),
  tool('hub_model_uninstall', 'Remove a local model and its owned files. Use the removalId from hub_models. Poll hub_job_status and reuse requestId on retry.', { toolId: string, removalId: string, requestId: string }, ['toolId', 'removalId', 'requestId'], true),
  tool('hub_model_cancel_download', 'Request cancellation of an active agent model download by jobId. Poll hub_job_status for the outcome.', { jobId: string }, ['jobId'], true),
  tool('hub_job_status', 'Read an agent model or tool lifecycle job. Job history lasts until the Hub exits.', { jobId: string }, ['jobId']),
  tool('hub_status', 'Inspect hardware, agent access, and the active pipeline run.'),
  tool('hub_tools', 'List installed tools with status. Does not launch them.'),
  tool('hub_models', 'List downloaded models and removal IDs for an installed tool. Use offset and limit for large inventories.', { toolId: string, offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['toolId']),
  tool('hub_node_types', 'Discover pipeline node types. Supply type for field schemas, inference options and backend choices. Optionally pass config to preview a configured node and ports.', { type: string, config: { type: 'object' } }),
  tool('hub_create_draft', 'Create an unsaved pipeline draft from node types, with real node IDs and default configurations.', { name: string, types: { type: 'array', items: string, minItems: 1, maxItems: 100 } }, ['name', 'types']),
  tool('hub_pipelines', 'List saved pipelines.'),
  tool('hub_get_pipeline', 'Get a saved pipeline definition.', { pipelineId: string }, ['pipelineId']),
  tool('hub_validate_pipeline', 'Validate a definition against installed capabilities. Does not run or save it.', { definition }, ['definition']),
  tool('hub_save_pipeline', 'Save a draft or replace a saved pipeline. Require overwrite=true to replace an existing ID.', { definition, overwrite: { type: 'boolean' } }, ['definition'], true),
  tool('hub_run_pipeline', 'Start a saved pipeline asynchronously. May launch installed backends and use configured paid providers. Reuse requestId when retrying the same request; poll hub_run_status. Recorder steps require the user in the app. Check pendingValidation for agent review.', { pipelineId: string, requestId: string }, ['pipelineId', 'requestId'], true),
  tool('hub_review_preview', 'Preview the image currently paused for review in an agent-started pipeline.', { runId: string, requestId: string }, ['runId','requestId']),
  tool('hub_review_decision', 'Pass or fail the current agent-started validation. Use the pending requestId. In a retry loop or reviewed map, fail retries according to the saved graph. When pendingValidation.retryControls.imageGeneration is present, retryOverrides.imageGeneration accepts prompt and seed.', { runId: string, requestId: string, decision: { ...string, enum: ['pass','fail'] }, comment: { ...string, maxLength: 4000 }, retryOverrides: { type: 'object' } }, ['runId','requestId','decision'], true),
  tool('hub_run_status', 'Read current or recent run status. Agent run history lasts for this app session.', { runId: string }),
  tool('hub_cancel_run', 'Cancel the specified active pipeline and clean up its managed tools.', { runId: string }, ['runId'], true),
  tool('hub_outputs', 'List saved output metadata, optionally for one run. Files remain local.', { runId: string }),
  tool('hub_read_output', 'Read up to 64 KiB of a saved text output by output ID. Media outputs return metadata and a local path.', { outputId: string }, ['outputId']),
];
function validateArguments(name, args) {
  const entry = TOOLS.find(t => t.name === name);
  if (!entry) throw Object.assign(new Error('That agent operation is not supported.'), { code: 'UNKNOWN_OPERATION' });
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  const { properties, required } = entry.inputSchema;
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new Error(`Unknown argument: ${key}.`);
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec.enum && !spec.enum.includes(value)) throw new Error(key + ' must be one of: ' + spec.enum.join(', ') + '.');
    if (['number', 'integer'].includes(spec.type) && (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value)) || value < spec.minimum || value > spec.maximum)) throw new Error(key + ' is outside the supported numeric range.');
    if (spec.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > spec.maxLength)) throw new Error(`${key} must be nonempty text of at most ${spec.maxLength} characters.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${key} must be an object.`);
    if (spec.type === 'array' && (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 200))) throw new Error(`${key} must contain 1 to 100 node type names.`);
  }
}
module.exports = { TOOLS, validateArguments };
