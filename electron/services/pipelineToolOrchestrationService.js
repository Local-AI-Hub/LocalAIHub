const { getLocalToolRequirement, getModelStepExecutionMode, getModelStepOperationId, PIPELINE_OPERATION_IDS } = require('../shared/pipelineSchema.cjs');
const { getLocalAudioToolRuntimeMode, LOCAL_AUDIO_RUNTIME_MODE_IDS } = require('./localAudioService');
const { getLocalImageToolRuntimeMode, LOCAL_IMAGE_RUNTIME_MODE_IDS } = require('./localImageService');
const { getLocalVideoToolRuntimeMode, LOCAL_VIDEO_RUNTIME_MODE_IDS } = require('./localVideoService');
const { isToolActive, isToolReady, launchToolFromUserAction, stopTool } = require('./processService');
const { getResolvedToolState } = require('./toolStateService');

const TOOL_READY_POLL_INTERVAL_MS = 1500;
const TOOL_READY_TIMEOUT_PADDING_MS = 15000;
const TOOL_READY_FALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function updateContextTool(contextMaps, tool) {
  if (!contextMaps?.toolsById || !tool?.id) {
    return;
  }

  contextMaps.toolsById[tool.id] = tool;
}

function buildRunLabel(nodeLabel, toolName, template) {
  return template
    .replace('{nodeLabel}', nodeLabel || 'this step')
    .replace('{toolName}', toolName || 'this tool');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToolReadyTimeoutMs(tool) {
  const timeoutMs = Number(tool?.startupTimeoutMs);
  return Math.max(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0, TOOL_READY_FALLBACK_TIMEOUT_MS) + TOOL_READY_TIMEOUT_PADDING_MS;
}

function buildToolNotReadyMessage(tool) {
  const target = tool?.healthUrl || tool?.launchUrl || `http://127.0.0.1:${tool?.defaultPort || 0}`;
  return `${tool?.name || 'This tool'} did not become ready on ${target} before Local AI Hub stopped waiting for this pipeline step. Open the logs folder for the full launch details.`;
}

async function resolveManagedTool(toolId, contextMaps) {
  const normalizedToolId = String(toolId || '').trim().toLowerCase();
  if (!normalizedToolId) {
    return null;
  }

  const latestTool = await getResolvedToolState(normalizedToolId, {
    syncDiscovered: false,
  }).catch(() => null);
  const tool = latestTool || contextMaps?.toolsById?.[normalizedToolId] || null;
  if (tool) {
    updateContextTool(contextMaps, tool);
  }
  return tool;
}

function isPipelineManagedTool(tool) {
  return Boolean(tool?.id && (tool.launchUrl || tool.healthUrl));
}

function createPipelineToolOrchestrator(contextMaps = {}) {
  const sessionsByToolId = new Map();

  async function stopSession(toolId, reportProgress, message, runMessage) {
    const normalizedToolId = String(toolId || '').trim().toLowerCase();
    const session = sessionsByToolId.get(normalizedToolId);
    if (!session?.active || !session.startedByPipeline) {
      return;
    }

    const latestTool = (await resolveManagedTool(normalizedToolId, contextMaps)) || session.tool;
    reportProgress?.(message, runMessage);
    await stopTool(latestTool);

    const nextTool = {
      ...latestTool,
      lastError: null,
      status: 'stopped',
    };
    session.active = false;
    session.tool = nextTool;
    updateContextTool(contextMaps, nextTool);
  }

  async function waitForToolSessionReady(node, session, reportProgress) {
    const deadline = Date.now() + getToolReadyTimeoutMs(session?.tool);
    let lastProgressAt = 0;

    while (Date.now() < deadline) {
      const latestTool = (await resolveManagedTool(session.toolId, contextMaps)) || session.tool;
      session.tool = latestTool;
      updateContextTool(contextMaps, latestTool);

      const ready = await isToolReady(latestTool).catch(() => false);
      if (ready) {
        const nextTool = {
          ...latestTool,
          lastError: null,
          status: 'running',
        };
        session.active = true;
        session.tool = nextTool;
        updateContextTool(contextMaps, nextTool);
        return nextTool;
      }

      const active = await isToolActive(latestTool).catch(() => Boolean(session.active));
      const status = String(latestTool?.status || '').trim().toLowerCase();
      session.active = active || status === 'starting';

      if (status === 'error') {
        throw new Error(latestTool?.lastError || `${latestTool?.name || 'This tool'} could not finish starting for this pipeline step.`);
      }

      if (!active && status !== 'starting') {
        throw new Error(latestTool?.lastError || `${latestTool?.name || 'This tool'} stopped before it became ready for this pipeline step.`);
      }

      if (Date.now() - lastProgressAt >= 6000) {
        reportProgress?.(
          `${latestTool?.name || 'This tool'} is still starting. Local AI Hub is keeping the pipeline paused so it can keep control of the tool if it becomes ready late.`,
          buildRunLabel(node?.label, latestTool?.name, 'Waiting for {toolName} to be ready for {nodeLabel}...'),
        );
        lastProgressAt = Date.now();
      }

      await sleep(TOOL_READY_POLL_INTERVAL_MS);
    }

    const latestTool = (await resolveManagedTool(session.toolId, contextMaps)) || session.tool;
    session.tool = latestTool;
    if (session.startedByPipeline) {
      await stopTool(latestTool).catch(() => null);
      session.active = false;
    }

    throw new Error(latestTool?.lastError || buildToolNotReadyMessage(latestTool));
  }

  async function ensureToolForNode(node, reportProgress) {
    const requiredToolId = getLocalToolRequirement(node, contextMaps);
    if (!requiredToolId) {
      return null;
    }

    if (node?.type === 'llmPrompt' && getModelStepExecutionMode(node) === 'localTool') {
      if (
        getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.AUDIO_GENERATE
        && getLocalAudioToolRuntimeMode(requiredToolId) === LOCAL_AUDIO_RUNTIME_MODE_IDS.DIRECT_COMMAND
      ) {
        return null;
      }

      if (
        getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.VIDEO_GENERATE
        && getLocalVideoToolRuntimeMode(requiredToolId) === LOCAL_VIDEO_RUNTIME_MODE_IDS.DIRECT_COMMAND
      ) {
        return null;
      }

      if (
        getModelStepOperationId(node) === PIPELINE_OPERATION_IDS.IMAGE_TRANSFORM
        && getLocalImageToolRuntimeMode(requiredToolId) === LOCAL_IMAGE_RUNTIME_MODE_IDS.DIRECT_COMMAND
      ) {
        return null;
      }
    }

    const tool = await resolveManagedTool(requiredToolId, contextMaps);
    if (!tool || !isPipelineManagedTool(tool)) {
      return null;
    }

    const activeOwnedSession = [...sessionsByToolId.values()].find((entry) => entry.active && entry.startedByPipeline && entry.toolId !== tool.id) || null;
    if (activeOwnedSession) {
      await stopSession(
        activeOwnedSession.toolId,
        reportProgress,
        `Stopping ${activeOwnedSession.toolName} so this run only keeps one heavy local tool active at a time.`,
        buildRunLabel(node?.label, activeOwnedSession.toolName, 'Stopping {toolName} before {nodeLabel}...'),
      );
    }

    const existingSession = sessionsByToolId.get(tool.id) || null;
    const pipelineOwnsActiveSession = Boolean(existingSession?.active && existingSession.startedByPipeline);
    const wasActive = await isToolActive(tool).catch(() => Boolean(existingSession?.active));
    const wasReady = wasActive ? await isToolReady(tool).catch(() => false) : false;

    if (!wasActive) {
      reportProgress?.(
        `Launching ${tool.name} for this step.`,
        buildRunLabel(node?.label, tool.name, 'Launching {toolName} for {nodeLabel}...'),
      );
    } else if (!wasReady) {
      reportProgress?.(
        `Waiting for ${tool.name} to finish starting.`,
        buildRunLabel(node?.label, tool.name, 'Waiting for {toolName} to be ready for {nodeLabel}...'),
      );
    } else if (pipelineOwnsActiveSession) {
      reportProgress?.(
        `Local AI Hub already started ${tool.name} for this run, so it will reuse it for this step.`,
        buildRunLabel(node?.label, tool.name, 'Preparing {nodeLabel} with {toolName}...'),
      );
    } else {
      reportProgress?.(
        `${tool.name} was already running before this pipeline started, so Local AI Hub will reuse it.`,
        buildRunLabel(node?.label, tool.name, 'Preparing {nodeLabel} with {toolName}...'),
      );
    }

    const startedTool = await launchToolFromUserAction(tool, {
      allowPendingStartup: true,
      launchContext: 'pipeline-run',
      skipOpenInterface: true,
    });

    const session = {
      active: true,
      startedByPipeline: Boolean(existingSession?.startedByPipeline) || !wasActive,
      tool: startedTool,
      toolId: startedTool.id,
      toolName: startedTool.name || tool.name,
    };
    sessionsByToolId.set(session.toolId, session);
    updateContextTool(contextMaps, startedTool);

    const readyTool = wasReady || (String(startedTool?.status || '').trim().toLowerCase() === 'running' && await isToolReady(startedTool).catch(() => false))
      ? startedTool
      : await waitForToolSessionReady(node, session, reportProgress);

    session.active = true;
    session.tool = readyTool;
    updateContextTool(contextMaps, readyTool);

    if (!wasReady) {
      reportProgress?.(
        `${session.toolName} is ready for this step.`,
        buildRunLabel(node?.label, session.toolName, 'Running {nodeLabel} with {toolName}...'),
      );
    }

    return session;
  }

  async function releaseToolForNode(node, nextNode, reportProgress) {
    const requiredToolId = getLocalToolRequirement(node, contextMaps);
    if (!requiredToolId) {
      return;
    }

    const normalizedToolId = String(requiredToolId).trim().toLowerCase();
    const session = sessionsByToolId.get(normalizedToolId) || null;
    if (!session?.active || !session.startedByPipeline) {
      return;
    }

    const nextRequiredToolId = String(getLocalToolRequirement(nextNode, contextMaps) || '').trim().toLowerCase();
    if (nextRequiredToolId && nextRequiredToolId === normalizedToolId) {
      reportProgress?.(
        `${session.toolName} will stay running for the next pipeline step.`,
        buildRunLabel(nextNode?.label, session.toolName, 'Keeping {toolName} ready for {nodeLabel}...'),
      );
      return;
    }

    await stopSession(
      normalizedToolId,
      reportProgress,
      `Stopping ${session.toolName} because this run started it just for this step.`,
      buildRunLabel(node?.label, session.toolName, 'Stopping {toolName} after {nodeLabel}...'),
    );
  }

  async function dispose(reportProgress, reason = 'this pipeline run') {
    const activeOwnedSessions = [...sessionsByToolId.values()].filter((entry) => entry.active && entry.startedByPipeline);
    for (const session of activeOwnedSessions) {
      await stopSession(
        session.toolId,
        reportProgress,
        `Stopping ${session.toolName} because Local AI Hub started it for ${reason}.`,
        buildRunLabel(reason, session.toolName, 'Stopping {toolName} after {nodeLabel}...'),
      );
    }
  }

  return {
    dispose,
    ensureToolForNode,
    releaseToolForNode,
  };
}

module.exports = {
  createPipelineToolOrchestrator,
};
