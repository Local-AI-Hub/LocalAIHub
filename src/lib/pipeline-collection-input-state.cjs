const COLLECTION_INPUT_ITEM_TYPES = Object.freeze(['text', 'image', 'audio', 'video', 'file']);
const COLLECTION_INPUT_ITEM_TYPE_OPTIONS = Object.freeze(COLLECTION_INPUT_ITEM_TYPES.map((kind) => ({ kind, label: kind })));

function createCollectionInputStateId(prefix = 'collection-item') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCollectionInputItemType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return COLLECTION_INPUT_ITEM_TYPES.includes(normalized) ? normalized : 'text';
}

function getCollectionInputItems(node) {
  return Array.isArray(node?.config?.items) ? node.config.items : [];
}

function getCollectionInputItemId(item, index = 0) {
  return String(item?.id || item?.itemId || 'item-' + index);
}

function fileNameFromCollectionPath(filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}
function createCollectionInputItem(itemType, patch = {}, options = {}) {
  const kind = normalizeCollectionInputItemType(itemType);
  const createId = typeof options.createId === 'function' ? options.createId : createCollectionInputStateId;
  const id = String(patch.id || patch.itemId || createId('collection-item'));
  if (kind === 'text') {
    return { ...patch, id, kind, text: String(patch.text ?? patch.value ?? '') };
  }
  const filePath = String(patch.filePath || patch.path || '').trim();
  const displayName = String(patch.displayName || patch.fileName || fileNameFromCollectionPath(filePath)).trim();
  return { displayName, filePath, ...patch, id, kind };
}

function updateCollectionInputConfig(node, patch) {
  return {
    ...node,
    config: {
      ...(node?.config || {}),
      ...patch,
    },
  };
}

function addCollectionInputTextItemToNode(node, options = {}) {
  const itemType = normalizeCollectionInputItemType(node?.config?.itemType);
  return updateCollectionInputConfig(node, {
    itemType,
    items: [...getCollectionInputItems(node), createCollectionInputItem(itemType, {}, options)],
  });
}

function addCollectionInputFileItemToNode(node, filePath, itemType, options = {}) {
  const normalizedItemType = normalizeCollectionInputItemType(itemType);
  const displayName = String(options.displayName || fileNameFromCollectionPath(filePath)).trim();
  return updateCollectionInputConfig(node, {
    itemType: normalizedItemType,
    items: [
      ...getCollectionInputItems(node),
      createCollectionInputItem(
        normalizedItemType,
        { displayName, filePath: String(filePath || '').trim() },
        options,
      ),
    ],
  });
}

function updateCollectionInputItemInNode(node, itemId, patch) {
  const targetId = String(itemId || '');
  return updateCollectionInputConfig(node, {
    items: getCollectionInputItems(node).map((item, index) => (
      getCollectionInputItemId(item, index) === targetId ? { ...item, ...patch } : item
    )),
  });
}

function removeCollectionInputItemFromNode(node, itemId) {
  const targetId = String(itemId || '');
  return updateCollectionInputConfig(node, {
    items: getCollectionInputItems(node).filter((item, index) => getCollectionInputItemId(item, index) !== targetId),
  });
}

function moveCollectionInputItemInNode(node, itemId, direction) {
  const items = [...getCollectionInputItems(node)];
  const targetId = String(itemId || '');
  const index = items.findIndex((item, itemIndex) => getCollectionInputItemId(item, itemIndex) === targetId);
  const nextIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) {
    return node;
  }
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(index, 1);
  nextItems.splice(nextIndex, 0, movedItem);
  return updateCollectionInputConfig(node, { items: nextItems });
}

module.exports = {
  COLLECTION_INPUT_ITEM_TYPES,
  COLLECTION_INPUT_ITEM_TYPE_OPTIONS,
  addCollectionInputFileItemToNode,
  addCollectionInputTextItemToNode,
  createCollectionInputItem,
  createCollectionInputStateId,
  getCollectionInputItemId,
  getCollectionInputItems,
  moveCollectionInputItemInNode,
  normalizeCollectionInputItemType,
  removeCollectionInputItemFromNode,
  updateCollectionInputItemInNode,
};

module.exports.default = module.exports;



