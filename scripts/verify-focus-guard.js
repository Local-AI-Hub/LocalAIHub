const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const focusGuardPath = path.join(repoRoot, 'src', 'lib', 'focus-guard.js');
const pipelinePath = path.join(repoRoot, 'src', 'components', 'PipelineBuilderPanel.jsx');
const aiderPath = path.join(repoRoot, 'src', 'components', 'AiderPanel.jsx');
const modelManagerPath = path.join(repoRoot, 'src', 'components', 'ModelManager.jsx');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.className = attributes.className || '';
    this.disabled = Boolean(attributes.disabled);
    this.id = attributes.id || '';
    this.inert = Boolean(attributes.inert);
    this.isConnected = true;
    this.readOnly = Boolean(attributes.readOnly);
  }

  closest(selector) {
    return matchesEditableSelector(this, selector) ? this : null;
  }

  focus() {
    fakeDocument.activeElement = this;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  getBoundingClientRect() {
    return { height: 20, width: 100, x: 0, y: 0 };
  }
}

function matchesEditableSelector(element, selector) {
  const selectors = selector.split(',').map((entry) => entry.trim());
  return selectors.some((entry) => {
    if (entry === 'input' || entry === 'textarea' || entry === 'select') {
      return element.tagName.toLowerCase() === entry;
    }
    if (entry === '[contenteditable=""]') {
      return element.getAttribute('contenteditable') === '';
    }
    if (entry === '[contenteditable="true"]') {
      return element.getAttribute('contenteditable') === 'true';
    }
    if (entry === '[role="textbox"]') {
      return element.getAttribute('role') === 'textbox';
    }
    if (entry === '[data-console-input="true"]') {
      return element.getAttribute('data-console-input') === 'true';
    }
    if (entry === '[data-terminal-input="true"]') {
      return element.getAttribute('data-terminal-input') === 'true';
    }
    if (entry === '.xterm-helper-textarea') {
      return String(element.className || '').split(/\s+/).includes('xterm-helper-textarea');
    }
    return false;
  });
}

const listeners = {};
const fakeDocument = {
  activeElement: null,
  body: { querySelectorAll: () => [] },
  addEventListener(type, handler, capture) {
    listeners[type] = listeners[type] || [];
    listeners[type].push({ capture: Boolean(capture), handler });
  },
  hasFocus: () => false,
};

const logEntries = [];
let focusWindowCalls = 0;
let nativeConfirmCalls = 0;
let showConfirmDialogCalls = 0;
const fakeWindow = {
  confirm: () => {
    nativeConfirmCalls += 1;
    return true;
  },
  focus: () => {},
  getComputedStyle: () => ({ display: 'block', opacity: '1', pointerEvents: 'auto', position: 'static', visibility: 'visible', zIndex: 'auto' }),
  innerHeight: 900,
  innerWidth: 1200,
  localAIHub: {
    focusWindow: () => {
      focusWindowCalls += 1;
      return Promise.resolve({ focused: true, visible: true });
    },
    showConfirmDialog: () => {
      showConfirmDialogCalls += 1;
      return { ok: true, data: true };
    },
  },
  requestAnimationFrame: (callback) => callback(),
  setTimeout: (callback) => {
    callback();
    return 1;
  },
};

const source = fs.readFileSync(focusGuardPath, 'utf8')
  .replace(/export function (\w+)/g, 'function $1')
  + '\nmodule.exports = { expectNextPrintableKeyDiagnostic, installRendererInputFocusDiagnostics, isEditableTarget, logRendererActionDiagnostic };\n';
const context = {
  Element: FakeElement,
  console,
  document: fakeDocument,
  module: { exports: {} },
  Promise,
  window: fakeWindow,
};
vm.createContext(context);
vm.runInContext(source, context, { filename: focusGuardPath });
const focusGuard = context.module.exports;

for (const element of [
  new FakeElement('input'),
  new FakeElement('textarea'),
  new FakeElement('select'),
  new FakeElement('div', { contenteditable: 'true' }),
  new FakeElement('div', { role: 'textbox' }),
  new FakeElement('div', { 'data-console-input': 'true' }),
  new FakeElement('div', { 'data-terminal-input': 'true' }),
  new FakeElement('textarea', { className: 'xterm-helper-textarea' }),
]) {
  assert(focusGuard.isEditableTarget(element), `Expected ${element.tagName} to be editable.`);
}
assert(!focusGuard.isEditableTarget(new FakeElement('input', { disabled: true })), 'Disabled input should not be treated as editable.');
assert(!focusGuard.isEditableTarget(new FakeElement('button')), 'Button should not be treated as editable.');

focusGuard.installRendererInputFocusDiagnostics({
  log: (message, context, level) => logEntries.push({ context, level, message }),
});
assert(typeof fakeWindow.__LOCAL_AI_HUB_DESCRIBE_FOCUS__ === 'function', 'Focus describe helper should be installed.');
assert(typeof fakeWindow.__LOCAL_AI_HUB_EXPECT_PRINTABLE_DIAGNOSTIC__ === 'function', 'Printable diagnostic helper should be installed.');
assert(fakeWindow.confirm('Delete output?') === true, 'Wrapped confirm should preserve the confirm result.');
assert(showConfirmDialogCalls === 1, 'Wrapped confirm should use the main-process Electron confirmation when available.');
assert(nativeConfirmCalls === 0, 'Wrapped confirm should avoid browser-native confirm when Electron confirmation is available.');
assert(logEntries.some((entry) => entry.message === 'Confirm closed.' && entry.context?.mode === 'main-process-confirm'), 'Wrapped confirm should log main-process confirm focus state.');
const textarea = new FakeElement('textarea');
fakeDocument.activeElement = textarea;
fakeWindow.__LOCAL_AI_HUB_EXPECT_PRINTABLE_DIAGNOSTIC__('verify-output-delete', {});
const keyEvent = { altKey: false, ctrlKey: false, defaultPrevented: false, key: 'a', metaKey: false, target: textarea };
for (const listener of listeners.keydown || []) {
  listener.handler(keyEvent);
}
const inputEvent = { target: textarea };
for (const listener of listeners.input || []) {
  listener.handler(inputEvent);
}
assert(logEntries.some((entry) => entry.message === 'First printable key after focus-sensitive action.'), 'First printable key after an action should be logged.');
assert(logEntries.some((entry) => entry.message === 'First input event after focus-sensitive action.'), 'First input event after an action should be logged.');

const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
assert(pipelineSource.includes('interactiveTarget || isEditableTarget(event.target)'), 'Canvas mousedown must ignore editable targets.');
assert(pipelineSource.includes('!node || !pointer || isEditableTarget(event.target)'), 'Node drag must ignore editable targets.');
assert(pipelineSource.includes("expectNextPrintableKeyDiagnostic('pipeline-output-delete'"), 'Output delete should arm first-printable diagnostics.');
assert(/setOutputsBusyPath\(''\);[\s\S]*expectNextPrintableKeyDiagnostic\('pipeline-output-delete'/.test(pipelineSource), 'Output delete cleanup should clear busy path and arm diagnostics in finally.');

const aiderSource = fs.readFileSync(aiderPath, 'utf8');
assert(aiderSource.includes('data-terminal-input="true"'), 'Aider console input should be marked as terminal input.');
assert(aiderSource.includes("logRendererActionDiagnostic('aider-console-input'"), 'Aider console should log focus-safe send diagnostics.');

const modelManagerSource = fs.readFileSync(modelManagerPath, 'utf8');
assert(modelManagerSource.includes("logRendererActionDiagnostic('model-manager-search'"), 'Model Manager search should log focus-safe search diagnostics.');

console.log('Focus guard verifier passed.');
