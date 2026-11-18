import React from 'react';
import inference from '../../electron/shared/rvcInference.cjs';

const fields = [
  ['pitchChange', 'Pitch change (semitones)', 'Raise or lower the pitch. Twelve semitones equal one octave.'],
  ['indexRate', 'Index rate / feature retrieval mix', 'Higher values use more features from the voice index. This requires a matching index file.'],
  ['rmsMixRate', 'RMS mix rate', 'At 0, follow the source loudness envelope. At 1, keep the converted loudness envelope.'],
  ['protect', 'Protect voiceless consonants and breath sounds', 'Lower values preserve more of these sounds. Set to 0.5 to turn protection off.'],
];

export default function RvcInferenceControls({ node, updateNode }) {
  const settings = inference.normalizeRvcInference(node.config?.rvcInference);
  function setValue(key, value) {
    updateNode(node.id, (current) => ({
      ...current,
      config: {
        ...current.config,
        rvcInference: { ...current.config?.rvcInference, [key]: value },
      },
    }));
  }

  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-medium text-white">RVC inference settings</legend>
      <label className="block text-sm text-slate-200">
        Pitch extraction method
        <select className="store-input mt-2" value={settings.pitchMethod} onChange={(event) => setValue('pitchMethod', event.target.value)}>
          {inference.RVC_PITCH_METHODS.map((method) => (
            <option key={method} value={method}>{method === 'harvest' ? 'Harvest' : method.toUpperCase()}</option>
          ))}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label, help]) => {
          const { min, max, step } = inference.RVC_PARAMETERS[key];
          const id = node.id + '-rvc-' + key;
          return (
            <div key={key}>
              <label className="flex justify-between gap-2 text-sm text-slate-200" htmlFor={id}>
                {label}<span className="tabular-nums">{settings[key]}</span>
              </label>
              <input className="w-full accent-cyan-300" type="range" id={id} min={min} max={max} step={step}
                aria-describedby={id + '-help'} value={settings[key]} onChange={(event) => setValue(key, event.target.valueAsNumber)} />
              <p id={id + '-help'} className="text-xs leading-5 text-slate-400">{help}</p>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
