const { getLocalToolRequirement } = require('../shared/pipelineSchema.cjs');
const { isToolActive, isToolReady, launchToolFromUserAction, stopTool } = require('./processService');
const { getResolvedToolState } = require('./toolStateService');

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

  async function ensureToolForNode(node, reportProgress) {
    const requiredToolId = getLocalToolRequirement(node, contextMaps);
    if (!requiredToolId) {
      return null;
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



