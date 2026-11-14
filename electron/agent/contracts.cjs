const string = { type: 'string', minLength: 1, maxLength: 200 };
const definition = { type: 'object', description: 'Complete pipeline definition. Discover node defaults and ports with hub_node_types and hub_create_draft first.' };
function tool(name, description, properties = {}, required = [], mutating = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !mutating, destructiveHint: mutating, idempotentHint: !mutating, openWorldHint: true } };
}
const TOOLS = [
  tool('hub_deliver_media', 'Deliver a saved audio/video file: link mode returns expiring playback/download URLs usable on the Hub PC, not uploaded attachments. Audio mode returns audio bytes up to 700 KB; playback depends on client support. Links expire after 30 minutes and are revoked when agent access stops.', { outputId: string, mode: { ...string, enum: ['link', 'audio'] } }, ['outputId']),
  tool('hub_discovery', 'Discover configured provider capabilities, saved prompt/workflow presets and starter templates. Does not contact cloud providers.', { section: { ...string, enum: ['providers', 'presets', 'templates'] } }, ['section']),
  tool('hub_inspect_media', 'Inspect saved image, audio or video metadata. Optionally return a JPEG preview of an image or one video frame for visual inspection. No audio playback.', { outputId: string, preview: { type: 'boolean' }, timeSeconds: { type: 'number', minimum: 0, maximum: 86400 } }, ['outputId']),
  tool('hub_diagnostics', 'Get a bounded, redacted tool stdout/stderr tail and status. No arbitrary log paths.', { toolId: string, maxChars: { type: 'integer', minimum: 256, maximum: 16384 } }, ['toolId']),
  tool('hub_tool_action', 'Start or stop an installed tool as a background job. Blocked while a pipeline runs or another lifecycle action is pending. Launches are headless and may take minutes. Reuse requestId on retries. Poll hub_job_status.', { toolId: string, action: { ...string, enum: ['launch', 'stop'] }, requestId: string }, ['toolId', 'action', 'requestId'], true),
  tool('hub_job_status', 'Read an agent tool lifecycle job. Job history lasts until the Hub exits.', { jobId: string }, ['jobId']),
  tool('hub_status', 'Inspect hardware, agent access, and the active pipeline run.'),
  tool('hub_tools', 'List installed tools with status. Does not launch them.'),
  tool('hub_models', 'List downloaded models for an installed tool.', { toolId: string }, ['toolId']),
  tool('hub_node_types', 'Discover pipeline node types. Supply type to get defaults, ports and a sample node.', { type: string }),
  tool('hub_create_draft', 'Create an unsaved pipeline draft from node types, with real node IDs and default configurations.', { name: string, types: { type: 'array', items: string, minItems: 1, maxItems: 100 } }, ['name', 'types']),
  tool('hub_pipelines', 'List saved pipelines.'),
  tool('hub_get_pipeline', 'Get a saved pipeline definition.', { pipelineId: string }, ['pipelineId']),
  tool('hub_validate_pipeline', 'Validate a definition against installed capabilities. Does not run or save it.', { definition }, ['definition']),
  tool('hub_save_pipeline', 'Save a draft or replace a saved pipeline. Require overwrite=true to replace an existing ID.', { definition, overwrite: { type: 'boolean' } }, ['definition'], true),
  tool('hub_run_pipeline', 'Start a saved pipeline asynchronously. May launch installed backends and use configured paid providers. Reuse requestId when retrying the same request; poll hub_run_status. Recorder and human-review steps require the user in the app.', { pipelineId: string, requestId: string }, ['pipelineId', 'requestId'], true),
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
    if (spec.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > 200)) throw new Error(`${key} must be nonempty text of at most 200 characters.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${key} must be an object.`);
    if (spec.type === 'array' && (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 200))) throw new Error(`${key} must contain 1 to 100 node type names.`);
  }
}
module.exports = { TOOLS, validateArguments };
