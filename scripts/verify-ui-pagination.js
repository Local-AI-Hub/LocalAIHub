const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(repoRoot, 'src', 'App.jsx'), 'utf8');
const modelManagerSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'ModelManager.jsx'), 'utf8');
const paginationSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'PaginationControls.jsx'), 'utf8');
const cssSource = fs.readFileSync(path.join(repoRoot, 'src', 'index.css'), 'utf8');
const librarySource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'LibraryCard.jsx'), 'utf8');
const providerSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'ProviderCard.jsx'), 'utf8');
const storeSource = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'StoreCard.jsx'), 'utf8');

assert(appSource.includes("import PaginationControls, { clampPaginationPage, getPaginatedItems } from './components/PaginationControls';"), 'App should use shared pagination controls.');
assert(appSource.includes('const LIBRARY_PAGE_SIZE = 6;'), 'Library should use a fixed six-item page size.');
assert(appSource.includes('const STORE_PAGE_SIZE = 6;'), 'Store should use a fixed six-item page size.');
assert(appSource.includes("...connectedProviders.map((provider) => ({ id: `provider:${provider.id}`, provider, type: 'provider' }))"), 'Library pagination should include provider cards.');
assert(appSource.includes("...tools.map((tool) => ({ id: `tool:${tool.id}`, tool, type: 'tool' }))"), 'Library pagination should include installed tool cards.');
assert(appSource.includes('pagedLibraryItems.map((entry) => {'), 'Library should render the paged library list.');
assert(appSource.includes('xl:grid-cols-2 xl:grid-rows-3'), 'Library should use a stable desktop 2-column by 3-row paginated grid.');
assert(appSource.includes('<ProviderCard') && appSource.includes('<LibraryCard'), 'Library paged renderer should preserve provider and tool cards.');
assert(appSource.indexOf('const storeTools = useMemo') < appSource.indexOf('const pagedStoreTools = useMemo'), 'Store pagination should happen after search/category filtering.');
assert(/setStorePage\(1\);\s*\}, \[storeCategory, storeSearch\]\);/.test(appSource), 'Store search/category changes should reset to page one.');
assert(appSource.includes('pagedStoreTools.map((manifest) => ('), 'Store should render the paged Store card list.');
assert(appSource.includes('xl:grid-cols-2 xl:grid-rows-3 2xl:grid-cols-3 2xl:grid-rows-2'), 'Store should use stable desktop paginated grid rows.');
assert(appSource.includes('overflow-y-auto pb-4 pr-1'), 'Contained internal scroll regions should remain in App tabs.');

assert(modelManagerSource.includes("import PaginationControls, { clampPaginationPage, getPaginatedItems } from './PaginationControls';"), 'Model Manager should use shared pagination controls.');
assert(modelManagerSource.includes('const REMOTE_CATALOG_PAGE_SIZE = 6;'), 'Remote catalog should use a fixed six-item local page size.');
assert(modelManagerSource.includes('const pagedRemoteItems = useMemo('), 'Remote catalog should derive a paged loaded-results list.');
assert(modelManagerSource.includes('pagedRemoteItems.map((item) => {'), 'Remote catalog should render paged loaded results.');
assert(modelManagerSource.includes('pagination.hasMore'), 'Remote catalog should preserve Load More availability.');
assert(modelManagerSource.includes('handleLoadMore'), 'Remote catalog should preserve the existing Load More handler.');
assert(modelManagerSource.includes('}, [modelType, search, selectedSource, selectedToolId, sort, taskType]);'), 'Remote catalog filters/search/tool changes should reset to page one.');
assert(modelManagerSource.includes('overflow-y-auto pb-4 pr-1'), 'Model Manager should keep internal scroll containment.');

assert(paginationSource.includes('export function clampPaginationPage'), 'Shared pagination component should export clamping.');
assert(paginationSource.includes('export function getPaginatedItems'), 'Shared pagination component should export item slicing.');
assert(paginationSource.includes('if (totalPages <= 1)'), 'Pagination controls should hide when everything fits on one page.');
assert(paginationSource.includes('aria-label={`Previous ${normalizedLabel} page`}'), 'Previous button should keep focusable accessibility text.');
assert(paginationSource.includes('aria-label={`Next ${normalizedLabel} page`}'), 'Next button should keep focusable accessibility text.');

assert(cssSource.includes('@apply panel flex h-full min-h-0 flex-col overflow-hidden p-3;'), 'Library cards should have normalized height and overflow handling.');
assert(cssSource.includes('.library-card-expanded'), 'Expanded Library cards should keep settings and snapshots usable without growing the paginated page.');
assert(librarySource.includes('library-card-expanded'), 'Library cards should opt into expanded overflow only when settings are open.');
assert(cssSource.includes('@apply flex h-full min-h-0 flex-col overflow-hidden rounded-[24px]'), 'Store cards should have normalized height and overflow handling.');
assert(cssSource.includes('.compact-card-button'), 'Card action buttons should have a compact sizing helper.');
assert(cssSource.includes('.card-meta-value'), 'Card metadata should have a truncation helper.');
assert(librarySource.includes('compact-card-button'), 'Library card actions should use compact card buttons.');
assert(librarySource.includes('card-meta-value'), 'Library card metadata should be truncated inside normalized cards.');
assert(providerSource.includes('compact-card-button'), 'Provider card actions should use compact card buttons.');
assert(providerSource.includes('card-meta-value'), 'Provider card metadata should align with Library card sizing.');
assert(storeSource.includes('compact-card-button'), 'Store install action should use compact card buttons.');
assert(storeSource.includes('line-clamp-2 text-sm leading-5 text-slate-300'), 'Store card text should stay clamped with hover reveal support.');
console.log('UI pagination source checks passed.');
