import { formatMemory, formatTimestamp } from '../lib/formatters';

export default function HardwareGate({ hardware, onContinue, busy }) {
  return (
    <div className="min-h-screen bg-shell px-6 py-10 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
        <div className="panel grid w-full gap-8 overflow-hidden p-8 lg:grid-cols-[1.1fr,0.9fr] lg:p-10">
          <div className="space-y-6">
            <div className="space-y-3">
              <span className="status-pill border-accent/30 bg-accent/10 text-accent">
                First launch check
              </span>
              <h1 className="text-4xl font-semibold tracking-tight text-white">
                NestAI inspected this machine before installing anything.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-slate-300">
                The app stores this hardware profile locally in your AppData folder so future sessions can make safer recommendations.
              </p>
            </div>

            <div className="rounded-3xl border border-accent/20 bg-accent/10 p-6">
              <p className="text-sm uppercase tracking-[0.22em] text-accent/80">Compatibility</p>
              <p className="mt-3 text-2xl font-medium text-white">{hardware.compatibilityMessage}</p>
            </div>

            <button className="primary-button" disabled={busy} onClick={onContinue} type="button">
              {busy ? 'Saving...' : 'Continue to dashboard'}
            </button>
          </div>

          <div className="space-y-4 rounded-3xl border border-white/10 bg-white/5 p-6">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-slate-400">Primary GPU</p>
              <p className="mt-2 text-3xl font-semibold text-white">{hardware.gpuModel}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-4">
                <p className="text-sm text-slate-400">VRAM</p>
                <p className="mt-2 text-xl font-semibold text-white">{formatMemory(hardware.vramMb)}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-4">
                <p className="text-sm text-slate-400">System RAM</p>
                <p className="mt-2 text-xl font-semibold text-white">{formatMemory(hardware.systemRamMb)}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-4">
              <p className="text-sm text-slate-400">Detected</p>
              <p className="mt-2 text-base text-white">{formatTimestamp(hardware.detectedAt)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
