const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[data-console-input="true"]',
  '[data-terminal-input="true"]',
  '.xterm-helper-textarea',
].join(',');

const PRINTABLE_KEY_SUPPRESSION_THROTTLE_MS = 2000;
const NATIVE_DIALOG_FOCUS_CHECK_DELAYS_MS = [0, 50, 200];
let lastSuppressedKeyLogAt = 0;
let lastFocusRestoreLogAt = 0;
let lastEditableElement = null;
let pendingPrintableDiagnostic = null;
let confirmWrapped = false;

function isElement(value) {
  return typeof Element !== 'undefined' && value instanceof Element;
}

function getEditableElement(target) {
  if (!isElement(target)) {
    return null;
  }

  const editable = target.closest(EDITABLE_SELECTOR);
  if (!editable) {
    return null;
  }

  const disabled = editable.disabled === true || editable.getAttribute('aria-disabled') === 'true';
  return disabled ? null : editable;
}

export function isEditableTarget(target) {
  return Boolean(getEditableElement(target));
}

function describeElement(element) {
  if (!isElement(element)) {
    return { tagName: String(element?.tagName || 'unknown') };
  }

  return {
    className: String(element.className || '').slice(0, 160),
    disabled: Boolean(element.disabled),
    id: String(element.id || ''),
    inert: Boolean(element.inert),
    name: String(element.getAttribute('name') || ''),
    readOnly: Boolean(element.readOnly),
    role: String(element.getAttribute('role') || ''),
    tagName: String(element.tagName || '').toLowerCase(),
    type: String(element.getAttribute('type') || ''),
  };
}

function isPrintableKeyEvent(event) {
  return Boolean(event?.key && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey);
}

function getOverlayDiagnostics() {
  if (typeof document === 'undefined') {
    return [];
  }

  return Array.from(document.body?.querySelectorAll('*') || [])
    .map((element) => {
      const style = window.getComputedStyle(element);
      const position = style.position;
      if (position !== 'fixed' && position !== 'absolute') {
        return null;
      }

      const pointerEvents = style.pointerEvents;
      if (pointerEvents === 'none') {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const coversViewport = rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8;
      const invisible = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
      if (!coversViewport && !invisible) {
        return null;
      }

      return {
        className: String(element.className || '').slice(0, 160),
        display: style.display,
        id: String(element.id || ''),
        opacity: style.opacity,
        pointerEvents,
        position,
        rect: {
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        },
        tagName: String(element.tagName || '').toLowerCase(),
        visibility: style.visibility,
        zIndex: style.zIndex,
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function getFocusState(extra = {}) {
  return {
    ...extra,
    activeElement: typeof document === 'undefined' ? null : describeElement(document.activeElement),
    documentHasFocus: typeof document === 'undefined' ? false : document.hasFocus(),
    lastEditableElement: describeElement(lastEditableElement),
    overlays: getOverlayDiagnostics(),
  };
}

function logFocusDiagnostic(log, message, context, level = 'warn') {
  if (typeof log !== 'function') {
    return;
  }

  try {
    log(message, context, level);
  } catch {
    // Diagnostics must never affect typing.
  }
}

function requestAppFocus(reason) {
  try {
    window.focus?.();
  } catch {
    // Best effort only.
  }

  try {
    const focusWindow = window?.localAIHub?.focusWindow;
    if (typeof focusWindow === 'function') {
      Promise.resolve(focusWindow({ reason })).catch(() => {});
    }
  } catch {
    // Best effort only.
  }
}

function focusEditableCandidate() {
  const activeEditable = getEditableElement(document.activeElement);
  const candidate = activeEditable || (lastEditableElement?.isConnected ? lastEditableElement : null);
  if (!candidate || candidate.disabled || candidate.readOnly) {
    return false;
  }

  try {
    candidate.focus({ preventScroll: true });
    return document.activeElement === candidate;
  } catch {
    return false;
  }
}

function restoreAfterNativeDialog(reason, log, beforeState) {
  for (const delayMs of NATIVE_DIALOG_FOCUS_CHECK_DELAYS_MS) {
    window.setTimeout(() => {
      requestAppFocus(reason);
      const restoredEditable = focusEditableCandidate();
      const afterState = getFocusState({ restoredEditable });
      if (delayMs === NATIVE_DIALOG_FOCUS_CHECK_DELAYS_MS[NATIVE_DIALOG_FOCUS_CHECK_DELAYS_MS.length - 1] || !afterState.documentHasFocus) {
        logFocusDiagnostic(log, 'Native dialog focus restoration check.', {
          after: afterState,
          before: beforeState,
          delayMs,
          reason,
        }, afterState.documentHasFocus ? 'info' : 'warn');
      }
    }, delayMs);
  }
}

export function expectNextPrintableKeyDiagnostic(source, context = {}) {
  pendingPrintableDiagnostic = {
    context,
    inputLogged: false,
    keyLogged: false,
    source,
    startedAt: Date.now(),
  };
}

export function logRendererActionDiagnostic(action, phase, context = {}, level = 'info') {
  try {
    const logger = window?.localAIHub?.logRendererEvent;
    if (typeof logger !== 'function') {
      return;
    }

    Promise.resolve(logger({
      context: getFocusState({
        ...context,
        phase,
      }),
      level,
      message: `Renderer action ${action} ${phase}.`,
      source: 'renderer-focus-actions',
    })).catch(() => {});
  } catch {
    // Best-effort diagnostics only.
  }
}

function installNativeDialogFocusGuard({ log } = {}) {
  if (confirmWrapped || typeof window.confirm !== 'function') {
    return;
  }

  confirmWrapped = true;
  const nativeConfirm = window.confirm.bind(window);
  window.confirm = (message) => {
    const beforeState = getFocusState({ dialog: 'confirm' });
    const electronConfirm = window?.localAIHub?.showConfirmDialog;
    let result = false;
    let mode = 'browser-native-confirm';

    if (typeof electronConfirm === 'function') {
      const response = electronConfirm({ message: String(message || '') });
      if (!response?.ok) {
        logFocusDiagnostic(log, 'Main-process confirm failed; falling back to browser confirm.', {
          before: beforeState,
          message: String(response?.message || ''),
        }, 'warn');
        result = nativeConfirm(message);
      } else {
        mode = 'main-process-confirm';
        result = Boolean(response.data);
      }
    } else {
      result = nativeConfirm(message);
    }

    const afterState = getFocusState({ dialog: 'confirm', mode, result });
    logFocusDiagnostic(log, 'Confirm closed.', {
      after: afterState,
      before: beforeState,
      mode,
    }, afterState.documentHasFocus ? 'info' : 'warn');
    expectNextPrintableKeyDiagnostic(mode, { confirmed: result });

    if (mode === 'browser-native-confirm' || !afterState.documentHasFocus) {
      restoreAfterNativeDialog(mode, log, beforeState);
    }

    return result;
  };
}

export function installRendererInputFocusDiagnostics({ log } = {}) {
  if (typeof document === 'undefined' || window.__LOCAL_AI_HUB_INPUT_FOCUS_DIAGNOSTICS_INSTALLED) {
    return;
  }

  window.__LOCAL_AI_HUB_INPUT_FOCUS_DIAGNOSTICS_INSTALLED = true;
  window.__LOCAL_AI_HUB_DESCRIBE_FOCUS__ = () => getFocusState();
  window.__LOCAL_AI_HUB_EXPECT_PRINTABLE_DIAGNOSTIC__ = expectNextPrintableKeyDiagnostic;
  installNativeDialogFocusGuard({ log });

  document.addEventListener(
    'focusin',
    (event) => {
      const editable = getEditableElement(event.target);
      if (editable) {
        lastEditableElement = editable;
      }
    },
    true,
  );

  document.addEventListener(
    'pointerdown',
    (event) => {
      const editable = getEditableElement(event.target);
      if (editable) {
        lastEditableElement = editable;
      }
    },
    true,
  );

  document.addEventListener(
    'pointerup',
    (event) => {
      const editable = getEditableElement(event.target);
      if (!editable) {
        return;
      }

      lastEditableElement = editable;
      if (!document.hasFocus()) {
        requestAppFocus('editable-pointerup-without-document-focus');
      }

      window.requestAnimationFrame(() => {
        if (!editable.isConnected || document.activeElement === editable) {
          return;
        }

        try {
          editable.focus({ preventScroll: true });
        } catch {
          return;
        }

        const now = Date.now();
        if (now - lastFocusRestoreLogAt >= PRINTABLE_KEY_SUPPRESSION_THROTTLE_MS) {
          lastFocusRestoreLogAt = now;
          logFocusDiagnostic(log, 'Renderer restored focus to an editable field after pointer interaction.', getFocusState({
            target: describeElement(editable),
          }));
        }
      });
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!isPrintableKeyEvent(event)) {
        return;
      }

      const editable = getEditableElement(event.target);
      if (editable) {
        lastEditableElement = editable;
      }

      const pending = pendingPrintableDiagnostic;
      if (!pending || pending.keyLogged) {
        return;
      }

      pending.keyLogged = true;
      window.setTimeout(() => {
        logFocusDiagnostic(log, 'First printable key after focus-sensitive action.', getFocusState({
          actionContext: pending.context,
          defaultPrevented: Boolean(event.defaultPrevented),
          eventPhase: 'keydown-after-propagation',
          key: event.key,
          source: pending.source,
          target: describeElement(event.target),
          targetEditable: Boolean(editable),
          timeSinceActionMs: Date.now() - pending.startedAt,
        }), event.defaultPrevented || !editable ? 'warn' : 'info');
      }, 0);
    },
    true,
  );

  document.addEventListener(
    'input',
    (event) => {
      const pending = pendingPrintableDiagnostic;
      if (!pending || pending.inputLogged) {
        return;
      }

      pending.inputLogged = true;
      logFocusDiagnostic(log, 'First input event after focus-sensitive action.', getFocusState({
        actionContext: pending.context,
        source: pending.source,
        target: describeElement(event.target),
        targetEditable: isEditableTarget(event.target),
        timeSinceActionMs: Date.now() - pending.startedAt,
      }), 'info');
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (!isPrintableKeyEvent(event) || !isEditableTarget(event.target) || !event.defaultPrevented) {
      return;
    }

    const now = Date.now();
    if (now - lastSuppressedKeyLogAt < PRINTABLE_KEY_SUPPRESSION_THROTTLE_MS) {
      return;
    }

    lastSuppressedKeyLogAt = now;
    logFocusDiagnostic(log, 'Printable key input was prevented while an editable field was targeted.', getFocusState({
      key: event.key,
      target: describeElement(event.target),
    }));
  });
}