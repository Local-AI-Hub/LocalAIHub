import { useState } from 'react';

const PROMPT_STYLE_EMPTY_DRAFT = Object.freeze({
  id: '',
  name: '',
  description: '',
  targetKind: 'image',
  positivePrefix: '',
  requiredTermsText: '',
  positiveSuffix: '',
  negativePrompt: '',
  placement: 'suffix',
});

function splitPromptStyleTerms(value) {
  return String(value || '').split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function promptStyleToDraft(style = null) {
  if (!style) return { ...PROMPT_STYLE_EMPTY_DRAFT };
  return {
    id: style.id || '',
    name: style.name || '',
    description: style.description || '',
    targetKind: Array.isArray(style.targetKinds) ? style.targetKinds[0] || style.targetKind || 'any' : style.targetKind || 'any',
    positivePrefix: style.positivePrefix || '',
    requiredTermsText: Array.isArray(style.requiredTerms) ? style.requiredTerms.join('\n') : '',
    positiveSuffix: style.positiveSuffix || '',
    negativePrompt: style.negativePrompt || '',
    placement: style.placement || 'suffix',
  };
}

function buildPromptStylePayload(draft) {
  return {
    id: draft.id || undefined,
    name: draft.name,
    description: draft.description,
    targetKind: draft.targetKind || 'any',
    targetKinds: [draft.targetKind || 'any'],
    positivePrefix: draft.positivePrefix,
    requiredTerms: splitPromptStyleTerms(draft.requiredTermsText),
    positiveSuffix: draft.positiveSuffix,
    negativePrompt: draft.negativePrompt,
    placement: draft.placement || 'suffix',
    dedupe: true,
    lockRequiredTerms: true,
  };
}

function formatPromptStyleTarget(style) {
  const kinds = Array.isArray(style?.targetKinds) ? style.targetKinds : [style?.targetKind || 'any'];
  return kinds.join(', ');
}

export default function PromptStylePresetManager({ busyMap = {}, onDeletePromptStyle, onSavePromptStyle, promptStyles = [] }) {
  const [promptStyleDraft, setPromptStyleDraft] = useState(() => promptStyleToDraft(null));

  async function savePromptStyleDraft() {
    if (!promptStyleDraft.name.trim()) return;
    const saved = await onSavePromptStyle?.(buildPromptStylePayload(promptStyleDraft));
    if (saved) setPromptStyleDraft(promptStyleToDraft(null));
  }

  async function deletePromptStyle(id) {
    const removed = await onDeletePromptStyle?.(id);
    if (removed && promptStyleDraft.id === id) setPromptStyleDraft(promptStyleToDraft(null));
  }

  return (
    <div className="grid gap-3 xl:grid-cols-[0.9fr,1.1fr]">
      <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Saved styles</p>
          <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPromptStyleDraft(promptStyleToDraft(null))} type="button">New style</button>
        </div>
        <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
          {promptStyles.length ? promptStyles.map((style) => (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3" key={style.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-white">{style.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{formatPromptStyleTarget(style)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="ghost-button px-3 py-1.5 text-xs" onClick={() => setPromptStyleDraft(promptStyleToDraft(style))} type="button">Edit</button>
                  <button className="ghost-button px-3 py-1.5 text-xs" disabled={busyMap['settings:delete-prompt-style']} onClick={() => deletePromptStyle(style.id)} type="button">Delete</button>
                </div>
              </div>
              {style.requiredTerms?.length ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{style.requiredTerms.join(', ')}</p> : null}
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-400">No prompt styles saved yet.</div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-name">Name</label><input className="store-input mt-3" id="prompt-style-name" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, name: event.target.value }))} value={promptStyleDraft.name} /></div>
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-target">Target</label><select className="store-input mt-3" id="prompt-style-target" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, targetKind: event.target.value }))} value={promptStyleDraft.targetKind}><option value="image">Image</option><option value="audio">Audio</option><option value="video">Video</option><option value="text">Text</option><option value="any">Any</option></select></div>
        </div>
        <div className="mt-3"><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-description">Description</label><input className="store-input mt-3" id="prompt-style-description" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, description: event.target.value }))} value={promptStyleDraft.description} /></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-prefix">Positive prefix</label><textarea className="store-input mt-3 min-h-[84px] resize-none" id="prompt-style-prefix" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, positivePrefix: event.target.value }))} value={promptStyleDraft.positivePrefix} /></div>
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-suffix">Positive suffix</label><textarea className="store-input mt-3 min-h-[84px] resize-none" id="prompt-style-suffix" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, positiveSuffix: event.target.value }))} value={promptStyleDraft.positiveSuffix} /></div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-terms">Required terms</label><textarea className="store-input mt-3 min-h-[130px] resize-none" id="prompt-style-terms" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, requiredTermsText: event.target.value }))} placeholder={'anime film still\nhand-painted background'} value={promptStyleDraft.requiredTermsText} /></div>
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-negative">Negative prompt</label><textarea className="store-input mt-3 min-h-[130px] resize-none" id="prompt-style-negative" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, negativePrompt: event.target.value }))} placeholder="photorealistic, 3d render" value={promptStyleDraft.negativePrompt} /></div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="text-xs uppercase tracking-[0.18em] text-slate-500" htmlFor="prompt-style-placement">Required term placement</label><select className="store-input mt-3" id="prompt-style-placement" onChange={(event) => setPromptStyleDraft((draft) => ({ ...draft, placement: event.target.value }))} value={promptStyleDraft.placement}><option value="suffix">Suffix</option><option value="prefix">Prefix</option></select></div>
          <div className="flex items-end gap-2"><button className="primary-button" disabled={busyMap['settings:save-prompt-style'] || !promptStyleDraft.name.trim()} onClick={savePromptStyleDraft} type="button">{busyMap['settings:save-prompt-style'] ? 'Saving...' : promptStyleDraft.id ? 'Save style' : 'Create style'}</button><button className="ghost-button" onClick={() => setPromptStyleDraft(promptStyleToDraft(null))} type="button">Clear</button></div>
        </div>
      </div>
    </div>
  );
}
