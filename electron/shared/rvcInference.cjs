const RVC_PITCH_METHODS = ['rmvpe', 'pm', 'harvest', 'crepe'];

const RVC_PARAMETERS = {
  pitchChange: { min: -24, max: 24, step: 1, defaultValue: 0 },
  indexRate: { min: 0, max: 1, step: 0.01, defaultValue: 0.75 },
  rmsMixRate: { min: 0, max: 1, step: 0.01, defaultValue: 0.25 },
  protect: { min: 0, max: 0.5, step: 0.01, defaultValue: 0.33 },
};

function normalizeRvcInference(settings) {
  const pitchMethod = RVC_PITCH_METHODS.includes(settings?.pitchMethod) ? settings.pitchMethod : 'rmvpe';
  const result = { pitchMethod };
  for (const [key, { min, max, step, defaultValue }] of Object.entries(RVC_PARAMETERS)) {
    const raw = settings?.[key];
    const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    const bounded = Math.min(max, Math.max(min, value));
    result[key] = Number.isFinite(value) ? (step === 1 ? Math.round(bounded) : bounded) : defaultValue;
  }
  return result;
}

module.exports = { normalizeRvcInference, RVC_PARAMETERS, RVC_PITCH_METHODS };
