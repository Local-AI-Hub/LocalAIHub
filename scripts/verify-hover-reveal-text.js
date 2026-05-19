const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const repoRoot = path.resolve(__dirname, '..');
const hoverRevealSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'HoverRevealText.jsx'), 'utf8');
const librarySource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'LibraryCard.jsx'), 'utf8');
const providerSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'ProviderCard.jsx'), 'utf8');
const storeSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'StoreCard.jsx'), 'utf8');
const pipelineSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'PipelineBuilderPanel.jsx'), 'utf8');
const cssSource = fs.readFileSync(path.join(repoRoot, 'src', 'index.css'), 'utf8');

assert(hoverRevealSource.includes('export default function HoverRevealText'), 'Expected shared HoverRevealText component.');
assert(hoverRevealSource.includes('hover-reveal-popover'), 'HoverRevealText should render the styled reveal overlay.');
assert(hoverRevealSource.includes('aria-hidden="true"'), 'Hover reveal overlay should be hidden from assistive tech because visible text remains present.');
assert(hoverRevealSource.includes('title={title}'), 'HoverRevealText should keep a native title fallback.');

for (const [name, source] of [['LibraryCard', librarySource], ['StoreCard', storeSource]]) {
  assert(source.includes("import HoverRevealText from './HoverRevealText';"), name + ' should use the shared hover reveal component.');
  assert(source.includes('className="line-clamp-2 text-sm leading-5 text-slate-300"'), name + ' description should keep the existing two-line clamp styling.');
  assert(source.includes('revealClassName="hover-reveal-card-popover"'), name + ' description should opt into the card reveal style.');
  assert(source.includes('rootClassName="mt-2 block min-w-0"'), name + ' reveal wrapper should preserve card spacing and min-width behavior.');
}

assert(providerSource.includes("import HoverRevealText from './HoverRevealText';"), 'ProviderCard should use the shared hover reveal component.');
assert(providerSource.includes('const providerDescription = `Messages sent here are processed by ${provider.name}'), 'ProviderCard should keep its cloud-provider privacy description text.');
assert(providerSource.includes('className="line-clamp-2 text-sm leading-5 text-slate-300"'), 'ProviderCard description should keep the existing two-line clamp styling.');
assert(providerSource.includes('revealClassName="hover-reveal-card-popover"'), 'ProviderCard description should opt into the card reveal style.');
assert(providerSource.includes('rootClassName="mt-2 block min-w-0 max-w-3xl"'), 'ProviderCard reveal wrapper should preserve spacing, min-width, and max-width behavior.');

assert(pipelineSource.includes("import HoverRevealText from './HoverRevealText';"), 'Pipeline Builder should use the shared hover reveal component.');
assert((pipelineSource.match(/className="min-w-0 truncate"/g) || []).length >= 2, 'Pipeline port labels should preserve min-w-0 truncate styling.');
assert(pipelineSource.includes('hover-reveal-port-popover-input'), 'Input port labels should have a hover reveal placed away from the handle.');
assert(pipelineSource.includes('hover-reveal-port-popover-output'), 'Output port labels should have a hover reveal placed away from the handle.');
assert(pipelineSource.includes('rootClassName="hover-reveal-port-text"'), 'Pipeline port reveal wrapper should stay bounded inside the port pill.');

assert(cssSource.includes('.hover-reveal-popover'), 'Global CSS should define the hover reveal overlay.');
assert(cssSource.includes('pointer-events: none;'), 'Hover reveal overlays should not steal clicks or port drags.');
assert(cssSource.includes('z-index: 70;'), 'Hover reveal overlays should be readable without competing with modals.');
assert(cssSource.includes('.hover-reveal-card-popover'), 'Card reveal CSS should exist.');
assert(cssSource.includes('.hover-reveal-port-popover'), 'Pipeline port reveal CSS should exist.');
assert(cssSource.includes('.hover-reveal-text:hover > .hover-reveal-popover'), 'Hover reveal should be CSS-first.');

console.log('Hover reveal source guards passed.');
