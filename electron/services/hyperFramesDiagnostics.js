const { redactSensitiveText } = require('./redactionService');
const failures = [];
const active = new Map();
let last;
function startRender(nodeId) {
  const key = Symbol();
  const metadata = {nodeId:nodeId || '', startedAt:new Date().toISOString(), stage:'staging'};
  const logs = {stdout:'', stderr:''};
  const pending = {stdout:'', stderr:''};
  let progress = '';
  function classify(raw) {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
    const frame = line.match(/^\s*(?:[\u2580-\u259f\u2500-\u257f\s]+\d+(?:\.\d+)?%\s*)?Streaming frame\s+\d+\s*\/\s*\d+/i);
    return frame ? {progress:frame[0].trim(), text:line.slice(frame[0].length).trimStart()} : {text:line};
  }
  function append(stream,chunk) {
    const lines = (pending[stream] + chunk).split(/[\r\n]/);
    pending[stream] = lines.pop().slice(-65536);
    for (const raw of lines) {
      const line = classify(raw);
      if (line.progress) progress = line.progress;
      if (line.text) logs[stream] = (logs[stream] + line.text + '\n').slice(-65536);
    }
  }
  function snapshot(limit) {
    let latest = progress, truncated = false;
    function tail(stream) {
      const line = classify(pending[stream]);
      if (line.progress) latest = line.progress;
      const clean = redactSensitiveText(logs[stream] + line.text, {redactPaths:true});
      truncated ||= clean.length > limit;
      return clean.slice(-limit);
    }
    const stdout = tail('stdout'), stderr = tail('stderr');
    return {render:{...metadata, active:active.has(key), progress:latest}, stdout, stderr, truncated};
  }
  active.set(key,snapshot);
  return {
    stage(name) { metadata.stage = name; },
    onStdout(chunk) { append('stdout',chunk); },
    onStderr(chunk) { append('stderr',chunk); },
    finish(status) { metadata.stage = status; metadata.finishedAt = new Date().toISOString(); last = snapshot; active.delete(key); },
  };
}
function renderSnapshot(limit) {
  const snapshot = [...active.values()].at(-1) || last;
  return snapshot ? snapshot(limit) : null;
}
function recordFailure(error, nodeId) {
  failures.push({ time: new Date().toISOString(), nodeId: nodeId || '', ...(error.findings?.length ? {references:error.findings} : {}), code: error.code || 'HYPERFRAMES_RENDER_FAILED', message: redactSensitiveText(String(error.message), { redactPaths: true }).slice(0, 1600) });
  if (failures.length > 10) failures.shift();
}
function recentFailures(limit, referenceOffset = 0) {
  let remaining = limit;
  return failures.slice().reverse().flatMap(entry => {
    if (remaining <= 0) return [];
    const message = entry.message.slice(0, remaining);
    remaining -= message.length;
    const {references, ...summary} = entry;
    return [{ ...summary, message, ...(references ? {
      referenceCount:references.length, references:references.slice(referenceOffset,referenceOffset+100),
      nextReferenceOffset:referenceOffset+100 < references.length ? referenceOffset+100 : null,
    } : {}) }];
  });
}
module.exports = { recordFailure, recentFailures, startRender, renderSnapshot };
