import { useEffect, useState } from 'react';
export default function AgentAccessPanel() {
  const [access, setAccess] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let mounted = true;
    window.localAIHub.getAgentAccess().then(result => {
      if (!mounted) return;
      if (result.ok) setAccess(result.data); else setMessage(result.message);
    }).catch(() => { if (mounted) setMessage('Could not load agent access settings.'); });
    return () => { mounted = false; };
  }, []);
  async function toggle() {
    setBusy(true); setMessage('');
    try {
      const result = await window.localAIHub.setAgentAccess(!access?.enabled);
      if (!result.ok) throw new Error(result.message);
      setAccess(result.data);
      setMessage(result.data.running ? 'Agent access is enabled.' : 'Agent access is disabled. Existing pipeline jobs continue; cancel them in the pipeline view if needed.');
    } catch (error) { setMessage(error.message || 'Could not change agent access.'); }
    finally { setBusy(false); }
  }
  async function showExtension() {
    try {
      const result = await window.localAIHub.showAgentExtension();
      setMessage(result.ok ? result.data.message : result.message);
    } catch { setMessage('Could not locate the extension.'); }
  }
  return (
    <div className="panel p-4">
      <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Agent access</p>
      <h3 className="mt-1 text-xl font-semibold text-white">Connect Claude Desktop and other agents</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">Allow connected agents to inspect tools and models, create or overwrite pipelines, run or cancel workflows, launch or stop tools, inspect diagnostic logs, and read saved results and media previews, return small audio files, and create temporary local playback/download links. Workflows can read local input files and use your configured cloud providers. Data returned to a cloud agent becomes part of its conversation.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="primary-button" disabled={busy || !access} onClick={toggle} type="button">{busy ? 'Updating...' : access?.enabled ? 'Disable agent access' : 'Enable agent access'}</button>
        <span className="text-sm text-slate-300">{access?.running ? 'Available locally' : access?.enabled ? 'Enabled, but not connected' : 'Disabled'}</span>
        <button className="ghost-button" onClick={showExtension} type="button">Show Claude Desktop extension</button>
      </div>
      {message ? <p role="status" className="mt-3 text-sm text-slate-300">{message}</p> : null}
      <details className="mt-3 text-sm text-slate-300">
        <summary className="cursor-pointer">Connection instructions</summary>
        <p className="mt-2">Keep Local AI Hub open. In Claude Desktop, open Settings → Desktop app → Extensions → Advanced settings → Install Extension, then select LocalAIHub.mcpb. Approve its tools when prompted.</p>
        <p className="mt-2">For other MCP clients, use Node.js as the command and the server path below as its argument. CLI access uses the same connection. No public server or API key is required for the bridge.</p>
        <p className="mt-2 break-all">MCP server: {access?.serverPath}</p>
        <p className="mt-1 break-all">CLI: {access?.cliPath}</p>
      </details>
    </div>
  );
}
