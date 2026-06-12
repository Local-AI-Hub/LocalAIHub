import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../lib/formatters';

const MODES = [
  { id: 'screen', label: 'Screen', needsVideo: true, needsScreen: true },
  { id: 'systemAudio', label: 'System audio only', needsSystemAudio: true },
  { id: 'microphone', label: 'Microphone only', needsMicrophone: true },
  { id: 'webcam', label: 'Webcam only', needsVideo: true, needsWebcam: true },
  { id: 'screenMic', label: 'Screen + microphone', needsVideo: true, needsScreen: true, needsMicrophone: true },
  { id: 'webcamMic', label: 'Webcam + microphone', needsVideo: true, needsMicrophone: true, needsWebcam: true },
];

function formatElapsed(startedAt, now) {
  const started = new Date(startedAt || 0).getTime();
  if (!Number.isFinite(started) || started <= 0) {
    return '00:00';
  }
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatDate(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown time';
}

function statusClass(status) {
  if (status === 'completed') return 'border-signal/30 bg-signal/10 text-emerald-100';
  if (status === 'recording') return 'border-rose-400/40 bg-rose-400/10 text-rose-100';
  return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
}

function buildDefaultRegion(display) {
  const bounds = display?.captureBounds || display?.bounds || { x: 0, y: 0, width: 1280, height: 720 };
  const width = Math.max(64, Math.floor(Math.min(1280, Number(bounds.width) || 1280) / 2) * 2);
  const height = Math.max(64, Math.floor(Math.min(720, Number(bounds.height) || 720) / 2) * 2);
  return {
    x: (Number(bounds.x) || 0) + Math.max(0, Math.floor(((Number(bounds.width) || width) - width) / 2)),
    y: (Number(bounds.y) || 0) + Math.max(0, Math.floor(((Number(bounds.height) || height) - height) / 2)),
    width,
    height,
  };
}

function formatCaptureTarget(recording) {
  const target = recording?.captureTarget;
  if (target?.type === 'region') {
    return `Region ${target.width}x${target.height} at ${target.x}, ${target.y}`;
  }
  return recording?.sources?.screen ? 'Full desktop' : '';
}

function getRegionValidationMessage(region, display) {
  if (!display) return 'Choose an available display.';
  const [x, y, width, height] = [region.x, region.y, region.width, region.height].map(Number);
  if (![x, y, width, height].every(Number.isSafeInteger)) return 'Use whole numbers for all region fields.';
  if (width < 64 || height < 64) return 'Width and height must each be at least 64 pixels.';
  if (width % 2 !== 0 || height % 2 !== 0) return 'Width and height must be even numbers for H.264 recording.';
  if (width > 16384 || height > 16384 || width * height > 67108864) return 'Choose a smaller recording region.';
  const bounds = display.captureBounds || display.bounds;
  if (x < bounds.x || y < bounds.y || x + width > bounds.x + bounds.width || y + height > bounds.y + bounds.height) {
    return 'The region must stay inside the selected display.';
  }
  return '';
}

export default function RecorderPanel({ activeRecording, onActiveRecordingChange, onToast }) {
  const [devices, setDevices] = useState({ microphones: [], webcams: [] });
  const [displays, setDisplays] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [mode, setMode] = useState('screen');
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
  const [captureTargetType, setCaptureTargetType] = useState('desktop');
  const [displayId, setDisplayId] = useState('');
  const [region, setRegion] = useState({ x: 0, y: 0, width: 1280, height: 720 });
  const [microphoneId, setMicrophoneId] = useState('');
  const [webcamId, setWebcamId] = useState('');
  const [fps, setFps] = useState(15);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingDisplays, setLoadingDisplays] = useState(true);
  const [busy, setBusy] = useState('');
  const [finalizingSlow, setFinalizingSlow] = useState(false);
  const [now, setNow] = useState(Date.now());

  const selectedMode = MODES.find((entry) => entry.id === mode) || MODES[0];
  const hasMicrophone = devices.microphones.length > 0;
  const hasWebcam = devices.webcams.length > 0;
  const selectedDisplay = displays.find((display) => display.id === displayId) || null;
  const usesSystemAudio = selectedMode.needsSystemAudio || (mode === 'screen' && systemAudioEnabled);
  const usesElectronBackend = Boolean(usesSystemAudio);
  const regionValidationMessage = captureTargetType === 'region' ? getRegionValidationMessage(region, selectedDisplay) : '';
  const regionReady = !regionValidationMessage;
  const startDisabled = Boolean(activeRecording)
    || Boolean(busy)
    || (selectedMode.needsScreen && captureTargetType === 'region' && (loadingDisplays || !regionReady))
    || (usesSystemAudio && (loadingDisplays || !selectedDisplay))
    || (selectedMode.needsMicrophone && (!hasMicrophone || !microphoneId))
    || (selectedMode.needsWebcam && (!hasWebcam || !webcamId));

  const outputFormat = usesElectronBackend
    ? selectedMode.needsVideo ? 'WebM (MediaRecorder video + Opus)' : 'WebM (Opus audio)'
    : selectedMode.needsVideo ? 'MKV (H.264)' : 'WAV (PCM)';
  const backendLabel = usesElectronBackend ? 'Electron loopback capture' : 'FFmpeg local capture';

  async function loadDevices(forceRefresh = false) {
    setLoadingDevices(true);
    try {
      const result = await window.localAIHub.listRecordingDevices(forceRefresh);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not refresh recording devices.', 'error');
        return;
      }
      const nextDevices = result.data || { microphones: [], webcams: [] };
      setDevices(nextDevices);
      setMicrophoneId((current) => nextDevices.microphones.some((device) => device.id === current) ? current : nextDevices.microphones[0]?.id || '');
      setWebcamId((current) => nextDevices.webcams.some((device) => device.id === current) ? current : nextDevices.webcams[0]?.id || '');
    } finally {
      setLoadingDevices(false);
    }
  }

  async function loadDisplays() {
    setLoadingDisplays(true);
    try {
      const result = await window.localAIHub.listRecordingDisplays();
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not read the available displays.', 'error');
        return;
      }
      const nextDisplays = result.data?.displays || [];
      const preferred = nextDisplays.find((display) => display.primary) || nextDisplays[0] || null;
      setDisplays(nextDisplays);
      setDisplayId(preferred?.id || '');
      if (preferred) setRegion(buildDefaultRegion(preferred));
    } finally {
      setLoadingDisplays(false);
    }
  }

  function selectDisplay(nextDisplayId) {
    const nextDisplay = displays.find((display) => display.id === nextDisplayId) || null;
    setDisplayId(nextDisplayId);
    if (nextDisplay) setRegion(buildDefaultRegion(nextDisplay));
  }

  async function selectRegion() {
    if (!displayId) {
      onToast('Choose an available display before selecting a region.', 'error');
      return;
    }
    setBusy('select-region');
    try {
      const result = await window.localAIHub.selectRecordingRegion(displayId);
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not open the region selector.', 'error');
        return;
      }
      const selectedRegion = result.data?.region;
      if (result.data?.canceled || !selectedRegion) {
        return;
      }
      setDisplayId(selectedRegion.displayId || displayId);
      setRegion({
        x: selectedRegion.x,
        y: selectedRegion.y,
        width: selectedRegion.width,
        height: selectedRegion.height,
      });
      onToast('Recording region selected. Review the coordinates, then start recording.');
    } finally {
      setBusy('');
    }
  }

  async function loadRecordings() {
    const result = await window.localAIHub.listRecordings();
    if (!result?.ok) {
      onToast(result?.message || 'Local AI Hub could not load recent recordings.', 'error');
      return;
    }
    setRecordings(result.data?.recordings || []);
  }

  useEffect(() => {
    loadDevices(false);
    loadDisplays();
    loadRecordings();
  }, []);

  useEffect(() => {
    if (!activeRecording) {
      loadRecordings();
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeRecording?.id]);

  const modeAvailability = useMemo(() => Object.fromEntries(MODES.map((entry) => [
    entry.id,
    (!entry.needsMicrophone || hasMicrophone)
      && (!entry.needsWebcam || hasWebcam)
      && (!entry.needsSystemAudio || displays.length > 0),
  ])), [hasMicrophone, hasWebcam, displays.length]);

  async function start() {
    setBusy('start');
    try {
      const captureTarget = selectedMode.needsScreen
        ? captureTargetType === 'region'
          ? {
              type: 'region',
              displayId,
              x: Number(region.x),
              y: Number(region.y),
              width: Number(region.width),
              height: Number(region.height),
            }
          : { type: 'desktop', displayId }
        : undefined;
      const result = await window.localAIHub.startRecording({
        mode,
        systemAudio: usesSystemAudio,
        displayId,
        microphoneId: selectedMode.needsMicrophone ? microphoneId : undefined,
        webcamId: selectedMode.needsWebcam ? webcamId : undefined,
        fps: Number(fps),
        captureTarget,
      });
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not start that recording.', 'error');
        return;
      }
      onActiveRecordingChange(result.data?.recording || null);
      onToast(result.data?.message || 'Recording started.');
    } finally {
      setBusy('');
    }
  }

  async function stop() {
    setBusy('stop');
    setFinalizingSlow(false);
    const slowTimer = window.setTimeout(() => setFinalizingSlow(true), 2500);
    try {
      const result = await window.localAIHub.stopRecording();
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not stop that recording.', 'error');
        return;
      }
      onActiveRecordingChange(null);
      onToast(result.data?.message || 'Recording stopped.');
    } finally {
      window.clearTimeout(slowTimer);
      setFinalizingSlow(false);
      setBusy('');
    }
  }

  async function cancel() {
    if (!window.confirm('Cancel this recording? An interrupted file may remain so Local AI Hub can report what happened.')) {
      return;
    }
    setBusy('cancel');
    try {
      const result = await window.localAIHub.cancelRecording();
      if (!result?.ok) {
        onToast(result?.message || 'Local AI Hub could not cancel that recording.', 'error');
        return;
      }
      onActiveRecordingChange(null);
      await loadRecordings();
      onToast(result.data?.message || 'Recording canceled.');
    } finally {
      setBusy('');
    }
  }

  async function runRecordingAction(action, fallbackMessage) {
    const result = await action();
    if (!result?.ok) {
      onToast(result?.message || fallbackMessage, 'error');
      return false;
    }
    if (result.data?.message) onToast(result.data.message);
    return true;
  }

  async function removeRecording(recording) {
    if (!window.confirm(`Delete ${recording.fileName || 'this recording'}? The current Settings deletion preference controls whether it uses the Recycle Bin.`)) {
      return;
    }
    setBusy(`delete:${recording.id}`);
    try {
      const deleted = await runRecordingAction(() => window.localAIHub.deleteRecording(recording.id), 'Local AI Hub could not delete that recording.');
      if (deleted) await loadRecordings();
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
      <div className="space-y-4">
        <div className="rounded-[28px] border border-white/10 bg-white/5 p-6 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Local capture</p>
              <h1 className="mt-2 text-2xl font-semibold text-white">Recorder</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">Record your desktop, system audio, microphone, or webcam directly to managed local storage. Nothing is uploaded.</p>
            </div>
            <button className="ghost-button" onClick={() => runRecordingAction(() => window.localAIHub.openRecordingsFolder(), 'Local AI Hub could not open the recordings folder.')} type="button">
              Open recordings folder
            </button>
          </div>

          <div className="mt-5 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100">
            Screen and system-audio recording may capture notifications, passwords, app or browser sounds, meeting audio, private conversations, or confidential work. Close sensitive apps and windows before you start.
          </div>

          {activeRecording ? (
            <div className="mt-5 rounded-2xl border border-rose-400/40 bg-rose-400/10 p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-rose-100">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
                    Recording in progress
                  </div>
                  <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{formatElapsed(activeRecording.startedAt, now)}</p>
                  <p className="mt-2 break-all text-xs text-rose-100/80">{activeRecording.outputPath || activeRecording.fileName}</p>
                </div>
                <div className="max-w-md">
                  <div className="flex flex-wrap gap-2">
                    <button className="primary-button" disabled={Boolean(busy)} onClick={stop} type="button">{busy === 'stop' ? 'Finalizing recording...' : 'Stop and save'}</button>
                    <button className="ghost-button" disabled={Boolean(busy)} onClick={cancel} type="button">{busy === 'cancel' ? 'Canceling...' : 'Cancel'}</button>
                  </div>
                  {busy === 'stop' && finalizingSlow ? (
                    <p className="mt-3 text-xs leading-5 text-rose-100/80">Finalizing recording; this can take a few seconds while the local capture backend writes the file.</p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <label className="space-y-2 text-sm text-slate-300">
                <span className="font-medium text-white">Recording mode</span>
                <select className="store-input w-full" onChange={(event) => setMode(event.target.value)} value={mode}>
                  {MODES.map((entry) => <option disabled={!modeAvailability[entry.id]} key={entry.id} value={entry.id}>{entry.label}{modeAvailability[entry.id] ? '' : ' (unavailable)'}</option>)}
                </select>
              </label>

              <label className="space-y-2 text-sm text-slate-300">
                <span className="font-medium text-white">Output format</span>
                <input className="store-input w-full" readOnly value={outputFormat} />
                <span className="text-xs text-slate-400">{backendLabel}</span>
              </label>

              {mode === 'screen' ? (
                <label className="flex items-start gap-3 rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-4 text-sm text-slate-200 lg:col-span-2">
                  <input checked={systemAudioEnabled} className="mt-1" onChange={(event) => setSystemAudioEnabled(event.target.checked)} type="checkbox" />
                  <span>
                    <span className="block font-medium text-white">Include system audio</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-400">Uses Electron loopback capture and saves WebM/Opus. App sounds, notifications, browser audio, and meeting audio may be recorded.</span>
                  </span>
                </label>
              ) : null}

              {usesSystemAudio ? (
                <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100 lg:col-span-2">
                  System audio capture is local, but it can include any sound Windows plays during the recording. Chromium requires a display capture grant even for audio-only output; audio-only mode discards the video track before recording.
                </div>
              ) : null}
              {selectedMode.needsScreen ? (
                <div className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/30 p-4 lg:col-span-2">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="space-y-2 text-sm text-slate-300">
                      <span className="font-medium text-white">Capture target</span>
                      <select className="store-input w-full" onChange={(event) => setCaptureTargetType(event.target.value)} value={captureTargetType}>
                        <option value="desktop">{usesSystemAudio ? 'Selected display' : 'Full desktop'}</option>
                        <option value="region">Region</option>
                      </select>
                    </label>
                    {captureTargetType === 'region' || usesSystemAudio ? (
                      <div className="space-y-2 text-sm text-slate-300">
                        <span className="font-medium text-white">Display</span>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <select className="store-input min-w-0 flex-1" disabled={loadingDisplays || !displays.length || Boolean(busy)} onChange={(event) => selectDisplay(event.target.value)} value={displayId}>
                            {displays.length ? displays.map((display) => {
                              const captureBounds = display.captureBounds || display.bounds;
                              return <option key={display.id} value={display.id}>{display.name}{display.primary ? ' (primary)' : ''} - {captureBounds.width}x{captureBounds.height}</option>;
                            }) : <option value="">No display detected</option>}
                          </select>
                          {captureTargetType === 'region' ? <button className="ghost-button whitespace-nowrap" disabled={loadingDisplays || !displayId || Boolean(busy)} onClick={selectRegion} type="button">{busy === 'select-region' ? 'Selecting...' : 'Select region'}</button> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {captureTargetType === 'region' ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                          ['x', 'X coordinate'],
                          ['y', 'Y coordinate'],
                          ['width', 'Width'],
                          ['height', 'Height'],
                        ].map(([key, label]) => (
                          <label className="space-y-2 text-sm text-slate-300" key={key}>
                            <span className="font-medium text-white">{label}</span>
                            <input className="store-input w-full" min={key === 'width' || key === 'height' ? 64 : undefined} onChange={(event) => setRegion((current) => ({ ...current, [key]: event.target.value }))} step={key === 'width' || key === 'height' ? 2 : 1} type="number" value={region[key]} />
                          </label>
                        ))}
                      </div>
                      <p className="text-xs leading-5 text-slate-400">Coordinates use Windows virtual desktop screen coordinates. A monitor positioned left of or above the primary display may use negative X or Y values.</p>
                      {regionValidationMessage ? <p className="text-xs leading-5 text-amber-200">{regionValidationMessage}</p> : null}
                    </div>
                  ) : (
                    <p className="text-xs leading-5 text-slate-400">{usesSystemAudio ? 'Electron records the selected display with Windows loopback audio.' : 'Full desktop records the complete Windows virtual desktop, including every connected display.'}</p>
                  )}
                </div>
              ) : null}

              {selectedMode.needsSystemAudio ? (
                <div className="space-y-2 rounded-2xl border border-white/10 bg-slate-950/30 p-4 lg:col-span-2">
                  <label className="space-y-2 text-sm text-slate-300">
                    <span className="font-medium text-white">Display permission source</span>
                    <select className="store-input w-full" disabled={loadingDisplays || !displays.length || Boolean(busy)} onChange={(event) => selectDisplay(event.target.value)} value={displayId}>
                      {displays.length ? displays.map((display) => {
                        const captureBounds = display.captureBounds || display.bounds;
                        return <option key={display.id} value={display.id}>{display.name}{display.primary ? ' (primary)' : ''} - {captureBounds.width}x{captureBounds.height}</option>;
                      }) : <option value="">No display detected</option>}
                    </select>
                  </label>
                  <p className="text-xs leading-5 text-slate-400">Electron requests this display to obtain Windows loopback audio, then records only the Opus audio track.</p>
                </div>
              ) : null}
              {selectedMode.needsMicrophone ? (
                <label className="space-y-2 text-sm text-slate-300">
                  <span className="font-medium text-white">Microphone</span>
                  <select className="store-input w-full" disabled={!hasMicrophone} onChange={(event) => setMicrophoneId(event.target.value)} value={microphoneId}>
                    {hasMicrophone ? devices.microphones.map((device) => <option key={device.id} value={device.id}>{device.name}</option>) : <option value="">No microphone detected</option>}
                  </select>
                </label>
              ) : null}

              {selectedMode.needsWebcam ? (
                <label className="space-y-2 text-sm text-slate-300">
                  <span className="font-medium text-white">Webcam</span>
                  <select className="store-input w-full" disabled={!hasWebcam} onChange={(event) => setWebcamId(event.target.value)} value={webcamId}>
                    {hasWebcam ? devices.webcams.map((device) => <option key={device.id} value={device.id}>{device.name}</option>) : <option value="">No webcam detected</option>}
                  </select>
                </label>
              ) : null}

              {selectedMode.needsVideo ? (
                <label className="space-y-2 text-sm text-slate-300">
                  <span className="font-medium text-white">Frame rate</span>
                  <select className="store-input w-full" onChange={(event) => setFps(Number(event.target.value))} value={fps}>
                    <option value={10}>10 FPS</option>
                    <option value={15}>15 FPS (lower impact)</option>
                    <option value={24}>24 FPS</option>
                    <option value={30}>30 FPS</option>
                    <option value={60}>60 FPS</option>
                  </select>
                </label>
              ) : null}

              {['microphone', 'screenMic', 'webcam', 'webcamMic'].includes(mode) ? <p className="text-xs leading-5 text-slate-400 lg:col-span-2">System audio is unavailable for this combination. Microphone and webcam modes remain on the FFmpeg backend; cross-backend audio synchronization is deferred.</p> : null}
              <div className="flex flex-wrap items-end gap-2 lg:col-span-2">
                <button className="primary-button" disabled={startDisabled} onClick={start} type="button">{busy === 'start' ? 'Starting...' : 'Start recording'}</button>
                <button className="ghost-button" disabled={loadingDevices || Boolean(busy)} onClick={() => loadDevices(true)} type="button">{loadingDevices ? 'Scanning devices...' : 'Refresh devices'}</button>
                {!hasWebcam ? <span className="text-xs text-slate-400">No webcam detected. Webcam modes are disabled.</span> : null}
                {!hasMicrophone ? <span className="text-xs text-slate-400">No microphone detected. Microphone modes are disabled.</span> : null}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-[28px] border border-white/10 bg-white/5 p-6 shadow-soft">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Managed storage</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Recent recordings</h2>
            </div>
            <button className="ghost-button" onClick={loadRecordings} type="button">Refresh</button>
          </div>

          <div className="mt-4 space-y-3">
            {recordings.length ? recordings.map((recording) => (
              <article className="rounded-2xl border border-white/10 bg-slate-950/35 p-4" key={recording.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="break-all font-medium text-white">{recording.fileName || recording.id}</p>
                      <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusClass(recording.status)}`}>{recording.status}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">{formatDate(recording.startedAt)} · {recording.mode} · {recording.backend || 'ffmpeg'} · {recording.audioSources?.includes('systemAudio') ? 'system audio · ' : ''}{formatBytes(recording.sizeBytes || 0)}{formatCaptureTarget(recording) ? ` · ${formatCaptureTarget(recording)}` : ''}</p>
                    {recording.errorSummary ? <p className="mt-2 text-sm text-amber-100">{recording.errorSummary}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="ghost-button" disabled={!recording.fileExists} onClick={() => runRecordingAction(() => window.localAIHub.openRecording(recording.id), 'Local AI Hub could not open that recording.')} type="button">Open</button>
                    <button className="ghost-button" disabled={!recording.fileExists} onClick={() => runRecordingAction(() => window.localAIHub.revealRecording(recording.id), 'Local AI Hub could not reveal that recording.')} type="button">Reveal</button>
                    <button className="ghost-button" disabled={busy === `delete:${recording.id}`} onClick={() => removeRecording(recording)} type="button">{busy === `delete:${recording.id}` ? 'Deleting...' : 'Delete'}</button>
                  </div>
                </div>
              </article>
            )) : (
              <div className="rounded-2xl border border-dashed border-white/15 px-5 py-8 text-center text-sm text-slate-400">No recordings yet. Your first completed or interrupted capture will appear here.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
