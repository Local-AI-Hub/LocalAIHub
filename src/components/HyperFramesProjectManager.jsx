import React, { useEffect, useMemo, useState } from 'react';
import HyperFramesProjectEditor from './HyperFramesProjectEditor';

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function safeTimestamp(value) {
  const text = safeText(value);
  if (!text) return null;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? text : null;
}

function safeStatus(value) {
  return safeText(value, 'needs-attention').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'needs-attention';
}

function formatDate(value) {
  const timestamp = safeTimestamp(value);
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export function normalizeHyperFramesTemplateForUi(template, index = 0) {
  const source = template && typeof template === 'object' ? template : {};
  const id = safeText(source.id, `template-${index + 1}`);
  return {
    id,
    label: safeText(source.label || source.name, id),
    description: safeText(source.description),
    localAssetsOnly: source.localAssetsOnly !== false,
    version: Math.max(1, Number(source.version || 1) || 1),
    sourceType: safeText(source.sourceType, 'starter-template'),
  };
}

export function normalizeHyperFramesBlankProjectForUi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = normalizeHyperFramesTemplateForUi(value);
  return { ...normalized, id: 'blank', label: safeText(value.label, 'Blank Project'), sourceType: 'blank-scaffold' };
}

export function normalizeHyperFramesTemplatesForUi(value) {
  return (Array.isArray(value) ? value : []).map((entry, index) => normalizeHyperFramesTemplateForUi(entry, index));
}

export function normalizeHyperFramesProjectForUi(project, index = 0) {
  const source = project && typeof project === 'object' ? project : {};
  const healthSource = source.health && typeof source.health === 'object' ? source.health : {};
  const projectId = safeText(source.projectId, `damaged-project-${index + 1}`);
  const healthStatus = safeStatus(healthSource.status);
  const healthMessage = safeText(healthSource.message, healthStatus === 'healthy' ? 'This managed HyperFrames project is ready for the pipeline.' : 'This HyperFrames project needs attention before it can be rendered.');
  return {
    projectId,
    displayName: safeText(source.displayName, projectId),
    templateId: safeText(source.templateId),
    templateLabel: safeText(source.templateLabel, 'Unknown template'),
    templateVersion: Math.max(0, Number(source.templateVersion || 0) || 0),
    sourceType: safeText(source.sourceType, source.templateId === 'blank' ? 'blank-scaffold' : 'managed-project'),
    createdAt: safeTimestamp(source.createdAt),
    updatedAt: safeTimestamp(source.updatedAt),
    localAssetsOnly: source.localAssetsOnly === true,
    description: safeText(source.description),
    health: {
      status: healthStatus,
      message: healthMessage,
      runnable: Boolean(healthSource.runnable),
    },
  };
}

export function normalizeHyperFramesProjectsForUi(value) {
  return (Array.isArray(value) ? value : []).map((entry, index) => normalizeHyperFramesProjectForUi(entry, index));
}

function getApiMethod(name, unavailableMessage) {
  const api = typeof window !== 'undefined' ? window.localAIHub : null;
  const method = api && typeof api[name] === 'function' ? api[name] : null;
  if (!method) {
    throw new Error(unavailableMessage || 'HyperFrames project management is not available in this Local AI Hub build.');
  }
  return method;
}

function getResultMessage(result, fallback) {
  return safeText(result?.message || result?.error || result?.data?.message, fallback);
}

function healthClassName(project) {
  if (project?.health?.runnable) return 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100';
  return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
}

function healthLabel(project) {
  if (project?.health?.runnable) return 'Healthy';
  return safeText(project?.health?.status, 'Needs attention').replace(/-/g, ' ');
}

export default function HyperFramesProjectManager({ onProjectsChanged, onToast, onUseProjectInPipeline }) {
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [blankProject, setBlankProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyProjectId, setBusyProjectId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [editorProjectId, setEditorProjectId] = useState('');

  const defaultTemplateId = useMemo(() => blankProject?.id || templates[0]?.id || '', [blankProject, templates]);
  const editorProject = useMemo(() => projects.find((project) => project.projectId === editorProjectId) || null, [projects, editorProjectId]);

  async function loadProjects() {
    setLoading(true);
    setLoadError('');
    try {
      const listProjects = getApiMethod('listHyperFramesProjects', 'HyperFrames project listing is not available in this Local AI Hub build.');
      const listTemplates = getApiMethod('listHyperFramesProjectTemplates', 'HyperFrames project templates are not available in this Local AI Hub build.');
      const [projectResult, templateResult] = await Promise.all([listProjects(), listTemplates()]);

      if (!projectResult?.ok) {
        const message = getResultMessage(projectResult, 'Local AI Hub could not load HyperFrames projects.');
        setProjects([]);
        onProjectsChanged?.([]);
        setLoadError(message);
      } else {
        const nextProjects = normalizeHyperFramesProjectsForUi(projectResult.data?.projects);
        setProjects(nextProjects);
        onProjectsChanged?.(nextProjects);
      }

      if (!templateResult?.ok) {
        setTemplates([]);
        setStatusMessage(getResultMessage(templateResult, 'Local AI Hub could not load HyperFrames templates.'));
      } else {
        const nextTemplates = normalizeHyperFramesTemplatesForUi(templateResult.data?.templates);
        const nextBlankProject = normalizeHyperFramesBlankProjectForUi(templateResult.data?.blankProject);
        setTemplates(nextTemplates);
        setBlankProject(nextBlankProject);
        if (!templateId && (nextBlankProject?.id || nextTemplates[0]?.id)) setTemplateId(nextBlankProject?.id || nextTemplates[0].id);
      }
    } catch (error) {
      const message = safeText(error?.message, 'Local AI Hub could not load HyperFrames projects.');
      setProjects([]);
      onProjectsChanged?.([]);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  async function runProjectAction(projectId, action) {
    const safeProjectId = safeText(projectId);
    setBusyProjectId(safeProjectId || 'new');
    setStatusMessage('');
    try {
      const result = await action(safeProjectId);
      if (!result?.ok) throw new Error(getResultMessage(result, 'Local AI Hub could not update that HyperFrames project.'));
      await loadProjects();
      const message = getResultMessage(result, 'HyperFrames project updated.');
      setStatusMessage(message);
      onToast?.(message, 'success');
      return result.data;
    } catch (error) {
      const message = safeText(error?.message, 'Local AI Hub could not update that HyperFrames project.');
      setStatusMessage(message);
      onToast?.(message, 'error');
      return null;
    } finally {
      setBusyProjectId('');
    }
  }

  async function createProject() {
    const selectedTemplateId = templateId || defaultTemplateId;
    await runProjectAction('', () => getApiMethod('createHyperFramesProject')({
      displayName,
      templateId: selectedTemplateId,
    }));
    setDisplayName('');
    setCreateOpen(false);
  }

  async function renameProject(project) {
    const projectId = safeText(project?.projectId);
    if (!projectId) return;
    const nextName = window.prompt('Rename HyperFrames project', project.displayName || projectId);
    if (!nextName || nextName.trim() === project.displayName) return;
    await runProjectAction(projectId, (id) => getApiMethod('renameHyperFramesProject')({ projectId: id, displayName: nextName }));
  }

  async function duplicateProject(project) {
    const projectId = safeText(project?.projectId);
    if (!projectId) return;
    const nextName = window.prompt('Name the duplicated HyperFrames project', `${project.displayName || projectId} copy`);
    if (!nextName) return;
    await runProjectAction(projectId, (id) => getApiMethod('duplicateHyperFramesProject')({ projectId: id, displayName: nextName }));
  }

  async function deleteProject(project) {
    const projectId = safeText(project?.projectId);
    if (!projectId) return;
    if (!window.confirm(`Delete "${project.displayName || projectId}"?\n\nThis removes only this managed HyperFrames project folder. HyperFrames runtime files are not touched.`)) return;
    await runProjectAction(projectId, (id) => getApiMethod('deleteHyperFramesProject')({ projectId: id }));
  }

  async function openFolder(project) {
    const projectId = safeText(project?.projectId);
    if (!projectId) return;
    await runProjectAction(projectId, (id) => getApiMethod('openHyperFramesProjectFolder')({ projectId: id }));
  }

  async function useInPipeline(project) {
    const projectId = safeText(project?.projectId);
    if (!projectId) return;
    await runProjectAction(projectId, async (id) => {
      const result = await getApiMethod('prepareHyperFramesProjectPipeline')({ projectId: id });
      if (result?.ok) onUseProjectInPipeline?.(result.data?.pipeline, project);
      return result;
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 text-sm leading-6 text-slate-300">
        <p>Projects are stored under Local AI Hub managed storage and remain available if HyperFrames is repaired or reinstalled.</p>
        <p>This editor works only inside Local AI Hub-managed HyperFrames projects.</p>
        <p>HyperFrames compositions execute HTML/CSS/JavaScript when rendered. Edit and render only projects you trust.</p>
        <p>This version supports local project assets only. Remote http/https/data references are blocked.</p>
        <p>HyperFrames Studio support remains pending while its network and project-write behavior is reviewed.</p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Managed projects</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">Create a local starter, inspect its health, edit local files, manage assets, and hand it to HyperFrames Render.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="ghost-button px-3 py-1.5 text-xs" disabled={loading} onClick={loadProjects} type="button">Refresh</button>
            <button className="primary-button px-3 py-1.5 text-xs" onClick={() => setCreateOpen((current) => !current)} type="button">Create Project</button>
          </div>
        </div>

        {createOpen ? (
          <div className="mt-4 grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto] lg:items-end">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Starting point</span>
              <select className="store-input mt-2" onChange={(event) => setTemplateId(event.target.value)} value={templateId || defaultTemplateId}>
                {blankProject ? <option value={blankProject.id}>{blankProject.label}</option> : null}
                <optgroup label="Starter templates">
                  {templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
                </optgroup>
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Display name</span>
              <input className="store-input mt-2" onChange={(event) => setDisplayName(event.target.value)} placeholder="Untitled HyperFrames Project" value={displayName} />
            </label>
            <button className="primary-button px-3 py-2 text-xs" disabled={busyProjectId === 'new' || !(templateId || defaultTemplateId)} onClick={createProject} type="button">
              {busyProjectId === 'new' ? 'Creating...' : 'Create'}
            </button>
          </div>
        ) : null}

        {statusMessage ? <p className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs leading-5 text-slate-300">{statusMessage}</p> : null}
      </div>

      {loading ? <p className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">Loading HyperFrames projects...</p> : null}
      {!loading && loadError ? (
        <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-50">
          <p className="font-semibold text-white">HyperFrames projects could not load.</p>
          <p className="mt-2">{loadError}</p>
          <button className="ghost-button mt-3" disabled={loading} onClick={loadProjects} type="button">Retry</button>
        </div>
      ) : null}
      {!loading && !loadError && !projects.length ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-slate-950/35 p-5 text-sm leading-6 text-slate-300">
          <p className="font-semibold text-white">No HyperFrames projects yet.</p>
          <p className="mt-2 text-slate-400">Create a starter project to get a managed local index.html ready for the render pipeline.</p>
        </div>
      ) : null}

      {!loadError ? (
        <div className="grid gap-3">
          {projects.map((project, index) => {
            const busy = busyProjectId === project.projectId;
            const runnable = Boolean(project.health?.runnable);
            return (
              <article className="rounded-2xl border border-white/10 bg-slate-950/35 p-3" key={`${project.projectId}-${index}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-white">{project.displayName || project.projectId}</p>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${healthClassName(project)}`}>{healthLabel(project)}</span>
                      {project.localAssetsOnly ? <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-cyan-100">Local only</span> : null}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-400">{project.sourceType === 'blank-scaffold' ? 'Blank Project scaffold' : (project.templateLabel || 'Unknown template')} - Created {formatDate(project.createdAt)} - Updated {formatDate(project.updatedAt)}</p>
                    {project.health?.message ? <p className="mt-2 text-xs leading-5 text-slate-300">{project.health.message}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="primary-button px-3 py-1.5 text-xs" disabled={!runnable || busy} onClick={() => useInPipeline(project)} type="button">Use in Pipeline</button>
                    <button className="ghost-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => setEditorProjectId(project.projectId)} type="button">Open Editor</button>
                    <button className="ghost-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => openFolder(project)} type="button">Open Project Folder</button>
                    <button className="ghost-button px-3 py-1.5 text-xs" disabled={!runnable || busy} onClick={() => renameProject(project)} type="button">Rename</button>
                    <button className="ghost-button px-3 py-1.5 text-xs" disabled={!runnable || busy} onClick={() => duplicateProject(project)} type="button">Duplicate</button>
                    <button className="ghost-button px-3 py-1.5 text-xs" disabled={busy} onClick={() => deleteProject(project)} type="button">Delete</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {editorProject ? (
        <HyperFramesProjectEditor
          key={editorProject.projectId}
          onClose={() => setEditorProjectId('')}
          onProjectsChanged={loadProjects}
          onToast={onToast}
          project={editorProject}
        />
      ) : null}
    </div>
  );
}
