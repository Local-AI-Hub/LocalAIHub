import React, { useEffect, useMemo, useState } from 'react';

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

function healthClassName(project) {
  if (project?.health?.runnable) return 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100';
  return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
}

function healthLabel(project) {
  if (project?.health?.runnable) return 'Healthy';
  return project?.health?.status ? project.health.status.replace(/-/g, ' ') : 'Needs attention';
}

export default function HyperFramesProjectManager({ onProjectsChanged, onToast, onUseProjectInPipeline }) {
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyProjectId, setBusyProjectId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const defaultTemplateId = useMemo(() => templates[0]?.id || '', [templates]);

  async function loadProjects() {
    setLoading(true);
    try {
      const [projectResult, templateResult] = await Promise.all([
        window.localAIHub.listHyperFramesProjects?.(),
        window.localAIHub.listHyperFramesProjectTemplates?.(),
      ]);
      if (projectResult?.ok) {
        const nextProjects = projectResult.data?.projects || [];
        setProjects(nextProjects);
        onProjectsChanged?.(nextProjects);
      }
      if (templateResult?.ok) {
        const nextTemplates = templateResult.data?.templates || [];
        setTemplates(nextTemplates);
        if (!templateId && nextTemplates[0]?.id) setTemplateId(nextTemplates[0].id);
      }
      if (!projectResult?.ok) setStatusMessage(projectResult?.error || 'Local AI Hub could not load HyperFrames projects.');
      if (!templateResult?.ok) setStatusMessage(templateResult?.error || 'Local AI Hub could not load HyperFrames templates.');
    } catch (error) {
      setStatusMessage(error?.message || 'Local AI Hub could not load HyperFrames projects.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

  async function runProjectAction(projectId, action) {
    setBusyProjectId(projectId || 'new');
    setStatusMessage('');
    try {
      const result = await action();
      if (!result?.ok) throw new Error(result?.error || 'Local AI Hub could not update that HyperFrames project.');
      await loadProjects();
      if (result.data?.message) {
        setStatusMessage(result.data.message);
        onToast?.(result.data.message, 'success');
      }
      return result.data;
    } catch (error) {
      const message = error?.message || 'Local AI Hub could not update that HyperFrames project.';
      setStatusMessage(message);
      onToast?.(message, 'error');
      return null;
    } finally {
      setBusyProjectId('');
    }
  }

  async function createProject() {
    const selectedTemplateId = templateId || defaultTemplateId;
    await runProjectAction('', () => window.localAIHub.createHyperFramesProject?.({
      displayName,
      templateId: selectedTemplateId,
    }));
    setDisplayName('');
    setCreateOpen(false);
  }

  async function renameProject(project) {
    const nextName = window.prompt('Rename HyperFrames project', project.displayName || project.projectId);
    if (!nextName || nextName.trim() === project.displayName) return;
    await runProjectAction(project.projectId, () => window.localAIHub.renameHyperFramesProject?.({ projectId: project.projectId, displayName: nextName }));
  }

  async function duplicateProject(project) {
    const nextName = window.prompt('Name the duplicated HyperFrames project', `${project.displayName || project.projectId} copy`);
    if (!nextName) return;
    await runProjectAction(project.projectId, () => window.localAIHub.duplicateHyperFramesProject?.({ projectId: project.projectId, displayName: nextName }));
  }

  async function deleteProject(project) {
    if (!window.confirm(`Delete "${project.displayName || project.projectId}"?\n\nThis removes only this managed HyperFrames project folder. HyperFrames runtime files are not touched.`)) return;
    await runProjectAction(project.projectId, () => window.localAIHub.deleteHyperFramesProject?.({ projectId: project.projectId }));
  }

  async function openFolder(project) {
    await runProjectAction(project.projectId, () => window.localAIHub.openHyperFramesProjectFolder?.({ projectId: project.projectId }));
  }

  async function useInPipeline(project) {
    await runProjectAction(project.projectId, async () => {
      const result = await window.localAIHub.prepareHyperFramesProjectPipeline?.({ projectId: project.projectId });
      if (result?.ok) onUseProjectInPipeline?.(result.data?.pipeline, project);
      return result;
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 text-sm leading-6 text-slate-300">
        <p>Projects are stored under Local AI Hub managed storage and remain available if HyperFrames is repaired or reinstalled.</p>
        <p>HyperFrames projects can execute HTML/CSS/JavaScript when rendered. Open and render only projects you trust.</p>
        <p>This version provides project management and templates. In-app editing and preview come later.</p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Managed projects</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">Create a local starter, inspect its health, and hand it to HyperFrames Render.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="ghost-button px-3 py-1.5 text-xs" disabled={loading} onClick={loadProjects} type="button">Refresh</button>
            <button className="primary-button px-3 py-1.5 text-xs" onClick={() => setCreateOpen((current) => !current)} type="button">Create Project</button>
          </div>
        </div>

        {createOpen ? (
          <div className="mt-4 grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto] lg:items-end">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Template</span>
              <select className="store-input mt-2" onChange={(event) => setTemplateId(event.target.value)} value={templateId || defaultTemplateId}>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
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
      {!loading && !projects.length ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-slate-950/35 p-5 text-sm leading-6 text-slate-300">
          <p className="font-semibold text-white">No HyperFrames projects yet.</p>
          <p className="mt-2 text-slate-400">Create a starter project to get a managed local index.html ready for the render pipeline.</p>
        </div>
      ) : null}

      <div className="grid gap-3">
        {projects.map((project) => {
          const busy = busyProjectId === project.projectId;
          const runnable = Boolean(project.health?.runnable);
          return (
            <article className="rounded-2xl border border-white/10 bg-slate-950/35 p-3" key={project.projectId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-white">{project.displayName || project.projectId}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${healthClassName(project)}`}>{healthLabel(project)}</span>
                    {project.localAssetsOnly ? <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-cyan-100">Local only</span> : null}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">{project.templateLabel || 'Unknown template'} · Created {formatDate(project.createdAt)} · Updated {formatDate(project.updatedAt)}</p>
                  {project.health?.message ? <p className="mt-2 text-xs leading-5 text-slate-300">{project.health.message}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="primary-button px-3 py-1.5 text-xs" disabled={!runnable || busy} onClick={() => useInPipeline(project)} type="button">Use in Pipeline</button>
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
    </div>
  );
}
