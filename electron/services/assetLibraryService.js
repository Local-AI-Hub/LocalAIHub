const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

const { ensureStorage, getAppPaths } = require('./configService');
const { assertPathInside, isPathInside } = require('./pathSafetyService');

const MANIFEST_VERSION = 1;
const PREVIEW_URL_SCHEME = 'localaihub-asset';
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LIBRARY_TYPES = Object.freeze({
  soundEffects: {
    directoryName: 'sound-effects',
    label: 'Sound Effects',
    itemDirectoryName: 'items',
    supportedExtensions: new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a']),
  },
  fonts: {
    directoryName: 'fonts',
    label: 'Fonts',
    itemDirectoryName: 'items',
    supportedExtensions: new Set(['.ttf', '.otf']),
  },
  colorPalettes: {
    directoryName: 'color-palettes',
    label: 'Color Palettes',
    itemDirectoryName: '',
    supportedExtensions: new Set(),
  },
});

const PREVIEW_MIME_TYPES = Object.freeze({
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
});

function getPreviewMimeType(extension) {
  return PREVIEW_MIME_TYPES[String(extension || '').toLowerCase()] || 'application/octet-stream';
}

function supportsPreview(type, item) {
  const normalizedType = normalizeLibraryType(type);
  if (normalizedType === 'colorPalettes') {
    return false;
  }
  return LIBRARY_TYPES[normalizedType].supportedExtensions.has(String(item?.extension || '').toLowerCase());
}

function buildAssetPreviewUrl(type, libraryId, itemId) {
  const normalizedType = normalizeLibraryType(type);
  const safeLibraryId = sanitizeId(libraryId, 'library');
  const safeItemId = sanitizeId(itemId, 'item');
  return `${PREVIEW_URL_SCHEME}://asset-library/${encodeURIComponent(normalizedType)}/${encodeURIComponent(safeLibraryId)}/${encodeURIComponent(safeItemId)}`;
}

function buildFontPreviewFamily(libraryId, itemId) {
  return `LocalAIHubAssetFont-${sanitizeId(libraryId, 'library')}-${sanitizeId(itemId, 'item')}`;
}

function attachPreviewDetails(manifest) {
  const normalizedType = normalizeLibraryType(manifest?.type);
  if (normalizedType === 'colorPalettes') {
    return manifest;
  }

  return {
    ...manifest,
    items: (manifest.items || []).map((item) => {
      if (!supportsPreview(normalizedType, item)) {
        return item;
      }
      return {
        ...item,
        previewKind: normalizedType === 'soundEffects' ? 'audio' : 'font',
        previewMimeType: getPreviewMimeType(item.extension),
        previewUrl: buildAssetPreviewUrl(normalizedType, manifest.id, item.id),
        ...(normalizedType === 'fonts' ? { fontPreviewFamily: buildFontPreviewFamily(manifest.id, item.id) } : {}),
      };
    }),
  };
}
let operationQueue = Promise.resolve();

function queueOperation(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => null);
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeLibraryType(type) {
  const normalizedType = String(type || '').trim();
  if (!Object.prototype.hasOwnProperty.call(LIBRARY_TYPES, normalizedType)) {
    throw new Error('Choose Sound Effects, Fonts, or Color Palettes before managing assets.');
  }
  return normalizedType;
}

function sanitizeName(value, fallback = 'Untitled Library') {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 120) || fallback;
}

function slugify(value, fallback = 'library') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function sanitizeId(value, label = 'library') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SAFE_ID_PATTERN.test(normalized)) {
    throw new Error(`Local AI Hub refused to use an invalid ${label} identifier.`);
  }
  return normalized;
}

function uniqueName(baseName, existingNames) {
  const cleanBase = sanitizeName(baseName);
  const used = new Set((existingNames || []).map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
  if (!used.has(cleanBase.toLowerCase())) {
    return cleanBase;
  }

  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${cleanBase} (${index})`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${cleanBase} (${Date.now()})`;
}

function createStableId(name, fallback = 'library') {
  return `${slugify(name, fallback)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function getLibrariesRoot() {
  const appPaths = getAppPaths();
  return appPaths.librariesRoot || path.join(appPaths.managedRoot, 'libraries');
}

function getTypeRoot(type) {
  const normalizedType = normalizeLibraryType(type);
  return path.join(getLibrariesRoot(), LIBRARY_TYPES[normalizedType].directoryName);
}

function resolveLibraryDir(type, libraryId) {
  const normalizedType = normalizeLibraryType(type);
  const safeLibraryId = sanitizeId(libraryId, 'library');
  const typeRoot = path.resolve(getTypeRoot(normalizedType));
  const libraryDir = path.resolve(path.join(typeRoot, safeLibraryId));
  return assertPathInside(typeRoot, libraryDir, 'Local AI Hub refused to use a library outside managed storage.');
}

function getManifestPath(libraryDir) {
  return path.join(libraryDir, 'manifest.json');
}

function getItemsRoot(type, libraryDir) {
  const typeConfig = LIBRARY_TYPES[normalizeLibraryType(type)];
  if (!typeConfig.itemDirectoryName) {
    return null;
  }
  return assertPathInside(libraryDir, path.join(libraryDir, typeConfig.itemDirectoryName), 'Local AI Hub refused to use an item folder outside its library.');
}

function normalizeManagedPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.join('/');
}

function normalizeItemRecord(type, item, options = {}) {
  const now = nowIso();
  const itemId = sanitizeId(item?.id || createStableId(item?.displayName || item?.name || 'item', 'item'), 'item');
  const createdAt = item?.createdAt || now;
  const updatedAt = options.touch ? now : item?.updatedAt || createdAt;

  if (type === 'colorPalettes') {
    return {
      id: itemId,
      name: sanitizeName(item?.name || item?.displayName || 'Color', 'Color'),
      hex: normalizeHexColor(item?.hex || item?.hexValue),
      createdAt,
      updatedAt,
    };
  }

  const managedPath = normalizeManagedPath(item?.managedPath || item?.managedRelativePath || '');
  const managedFilename = path.basename(item?.managedFilename || managedPath || '');
  return {
    id: itemId,
    displayName: sanitizeName(item?.displayName || item?.name || item?.originalFilename || managedFilename || 'Imported item', 'Imported item'),
    originalFilename: path.basename(String(item?.originalFilename || managedFilename || '')),
    managedFilename,
    managedPath: managedPath || (managedFilename ? `items/${managedFilename}` : ''),
    extension: String(item?.extension || path.extname(managedFilename)).toLowerCase(),
    type: String(item?.type || type),
    durationSeconds: Number.isFinite(Number(item?.durationSeconds)) ? Number(item.durationSeconds) : null,
    sampleRate: Number.isFinite(Number(item?.sampleRate)) ? Number(item.sampleRate) : null,
    channels: Number.isFinite(Number(item?.channels)) ? Number(item.channels) : null,
    fontFamily: item?.fontFamily ? sanitizeName(item.fontFamily, '') : null,
    createdAt,
    updatedAt,
  };
}

function normalizeManifest(raw, type, libraryId, options = {}) {
  const normalizedType = normalizeLibraryType(type);
  const now = nowIso();
  const id = sanitizeId(raw?.id || libraryId, 'library');
  const items = Array.isArray(raw?.items)
    ? raw.items.map((entry) => {
        try {
          return normalizeItemRecord(normalizedType, entry);
        } catch {
          return null;
        }
      }).filter(Boolean)
    : [];

  return attachPreviewDetails({
    version: MANIFEST_VERSION,
    id,
    type: normalizedType,
    name: sanitizeName(raw?.name || options.fallbackName || id),
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || raw?.createdAt || now,
    items,
    manifestStatus: options.manifestStatus || 'ok',
    manifestMessage: options.manifestMessage || '',
  });
}

async function readManifest(type, libraryId, options = {}) {
  const normalizedType = normalizeLibraryType(type);
  const safeLibraryId = sanitizeId(libraryId, 'library');
  const libraryDir = resolveLibraryDir(normalizedType, safeLibraryId);
  const manifestPath = getManifestPath(libraryDir);
  const fallbackName = options.fallbackName || safeLibraryId;

  if (!(await fs.pathExists(manifestPath))) {
    return normalizeManifest(
      { id: safeLibraryId, name: fallbackName, items: [] },
      normalizedType,
      safeLibraryId,
      { manifestStatus: 'missing', manifestMessage: 'This library is missing its manifest. Local AI Hub can still manage the folder.', fallbackName },
    );
  }

  try {
    const raw = await fs.readJson(manifestPath);
    return normalizeManifest(raw, normalizedType, safeLibraryId);
  } catch {
    return normalizeManifest(
      { id: safeLibraryId, name: fallbackName, items: [] },
      normalizedType,
      safeLibraryId,
      { manifestStatus: 'corrupt', manifestMessage: 'This library manifest could not be read. Local AI Hub will rebuild it when you save changes.', fallbackName },
    );
  }
}

async function writeManifest(type, manifest) {
  const normalizedType = normalizeLibraryType(type);
  const safeLibraryId = sanitizeId(manifest?.id, 'library');
  const libraryDir = resolveLibraryDir(normalizedType, safeLibraryId);
  const typeConfig = LIBRARY_TYPES[normalizedType];
  await fs.ensureDir(libraryDir);
  if (typeConfig.itemDirectoryName) {
    await fs.ensureDir(getItemsRoot(normalizedType, libraryDir));
  }

  const normalizedManifest = normalizeManifest(
    {
      ...manifest,
      type: normalizedType,
      updatedAt: nowIso(),
    },
    normalizedType,
    safeLibraryId,
  );
  delete normalizedManifest.manifestStatus;
  delete normalizedManifest.manifestMessage;

  const tempPath = `${getManifestPath(libraryDir)}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeJson(tempPath, normalizedManifest, { spaces: 2 });
  await fs.move(tempPath, getManifestPath(libraryDir), { overwrite: true });
  return { ...normalizedManifest, manifestStatus: 'ok', manifestMessage: '' };
}

async function listAssetLibrariesDirect(type) {
  await ensureStorage();
  const normalizedType = normalizeLibraryType(type);
  const typeRoot = getTypeRoot(normalizedType);
  await fs.ensureDir(typeRoot);
  const entries = await fs.readdir(typeRoot, { withFileTypes: true }).catch(() => []);
  const libraries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) {
      continue;
    }
    libraries.push(await readManifest(normalizedType, entry.name, { fallbackName: entry.name }));
  }
  return libraries.sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
}

async function listAssetLibraries(type) {
  return queueOperation(() => listAssetLibrariesDirect(type));
}

async function createAssetLibrary(type, name) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = normalizeLibraryType(type);
    const existing = await listAssetLibrariesDirect(normalizedType);
    const libraryName = uniqueName(name, existing.map((library) => library.name));
    const libraryId = sanitizeId(createStableId(libraryName), 'library');
    const libraryDir = resolveLibraryDir(normalizedType, libraryId);
    await fs.ensureDir(libraryDir);
    if (LIBRARY_TYPES[normalizedType].itemDirectoryName) {
      await fs.ensureDir(getItemsRoot(normalizedType, libraryDir));
    }
    const timestamp = nowIso();
    const library = await writeManifest(normalizedType, {
      id: libraryId,
      type: normalizedType,
      name: libraryName,
      createdAt: timestamp,
      updatedAt: timestamp,
      items: [],
    });
    return { library, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

async function renameAssetLibrary(type, libraryId, name) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = normalizeLibraryType(type);
    const safeLibraryId = sanitizeId(libraryId, 'library');
    const existing = await listAssetLibrariesDirect(normalizedType);
    const library = await readManifest(normalizedType, safeLibraryId);
    const libraryName = uniqueName(name, existing.filter((entry) => entry.id !== safeLibraryId).map((entry) => entry.name));
    const updatedLibrary = await writeManifest(normalizedType, { ...library, name: libraryName });
    return { library: updatedLibrary, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

async function deleteAssetLibrary(type, libraryId) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = normalizeLibraryType(type);
    const typeRoot = path.resolve(getTypeRoot(normalizedType));
    const libraryDir = resolveLibraryDir(normalizedType, libraryId);
    assertPathInside(typeRoot, libraryDir, 'Local AI Hub refused to delete a folder outside the managed asset library area.');
    await fs.remove(libraryDir);
    return { message: `${LIBRARY_TYPES[normalizedType].label} library deleted.`, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

function validateImportExtension(type, filePath) {
  const normalizedType = normalizeLibraryType(type);
  if (normalizedType === 'colorPalettes') {
    throw new Error('Color Palette libraries use saved colors instead of imported files.');
  }

  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!LIBRARY_TYPES[normalizedType].supportedExtensions.has(extension)) {
    const allowed = [...LIBRARY_TYPES[normalizedType].supportedExtensions].join(', ');
    throw new Error(`Local AI Hub can only import ${allowed} files into ${LIBRARY_TYPES[normalizedType].label} libraries.`);
  }
  return extension;
}

function getUniqueItemName(baseName, existingItems, fieldName = 'displayName') {
  return uniqueName(baseName, (existingItems || []).map((item) => item?.[fieldName] || item?.name));
}

function buildManagedFilename(itemId, sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  const baseName = slugify(path.basename(sourcePath, extension), 'asset').slice(0, 60);
  return `${itemId}-${baseName}${extension}`;
}

function readWaveMetadata(filePath) {
  try {
    const header = Buffer.alloc(44);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, header, 0, 44, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return {};
    }
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const dataSize = header.readUInt32LE(40);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    const durationSeconds = bytesPerSecond > 0 ? Number((dataSize / bytesPerSecond).toFixed(3)) : null;
    return { channels, sampleRate, durationSeconds };
  } catch {
    return {};
  }
}

function decodeFontName(buffer, platformId, encodingId, offset, length) {
  const value = buffer.subarray(offset, offset + length);
  if (platformId === 0 || platformId === 3 || encodingId === 1 || encodingId === 10) {
    try {
      return value.toString('utf16be');
    } catch {
      let decoded = '';
      for (let index = 0; index + 1 < value.length; index += 2) {
        decoded += String.fromCharCode(value.readUInt16BE(index));
      }
      return decoded;
    }
  }
  return value.toString('latin1');
}

function readFontMetadata(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 12) {
      return {};
    }
    const tableCount = buffer.readUInt16BE(4);
    let nameTableOffset = 0;
    let nameTableLength = 0;
    for (let index = 0; index < tableCount; index += 1) {
      const tableOffset = 12 + (index * 16);
      if (tableOffset + 16 > buffer.length) break;
      const tag = buffer.toString('ascii', tableOffset, tableOffset + 4);
      if (tag === 'name') {
        nameTableOffset = buffer.readUInt32BE(tableOffset + 8);
        nameTableLength = buffer.readUInt32BE(tableOffset + 12);
        break;
      }
    }
    if (!nameTableOffset || nameTableOffset + 6 > buffer.length || nameTableOffset + nameTableLength > buffer.length) {
      return {};
    }
    const recordCount = buffer.readUInt16BE(nameTableOffset + 2);
    const stringStorageOffset = nameTableOffset + buffer.readUInt16BE(nameTableOffset + 4);
    const names = [];
    for (let index = 0; index < recordCount; index += 1) {
      const recordOffset = nameTableOffset + 6 + (index * 12);
      if (recordOffset + 12 > buffer.length) break;
      const platformId = buffer.readUInt16BE(recordOffset);
      const encodingId = buffer.readUInt16BE(recordOffset + 2);
      const languageId = buffer.readUInt16BE(recordOffset + 4);
      const nameId = buffer.readUInt16BE(recordOffset + 6);
      const length = buffer.readUInt16BE(recordOffset + 8);
      const stringOffset = stringStorageOffset + buffer.readUInt16BE(recordOffset + 10);
      if (stringOffset < stringStorageOffset || stringOffset + length > buffer.length) continue;
      const text = decodeFontName(buffer, platformId, encodingId, stringOffset, length).replace(/\u0000/g, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) {
        names.push({ languageId, nameId, platformId, text });
      }
    }
    const preferred = names.find((entry) => entry.nameId === 16 && entry.languageId === 0x0409)
      || names.find((entry) => entry.nameId === 1 && entry.languageId === 0x0409)
      || names.find((entry) => entry.nameId === 16)
      || names.find((entry) => entry.nameId === 1)
      || names.find((entry) => entry.nameId === 4);
    return preferred ? { fontFamily: sanitizeName(preferred.text, '') || null } : {};
  } catch {
    return {};
  }
}

function readItemMetadata(type, sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (type === 'soundEffects' && extension === '.wav') {
    return readWaveMetadata(sourcePath);
  }
  if (type === 'fonts') {
    return { fontFamily: readFontMetadata(sourcePath).fontFamily || sanitizeName(path.basename(sourcePath, extension), '') || null };
  }
  return {};
}

async function importAssetLibraryItems(type, libraryId, files = []) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = normalizeLibraryType(type);
    const sourceFiles = Array.isArray(files) ? files : [];
    if (!sourceFiles.length) {
      throw new Error('Choose at least one file to import.');
    }

    const library = await readManifest(normalizedType, libraryId);
    const libraryDir = resolveLibraryDir(normalizedType, library.id);
    const itemsRoot = getItemsRoot(normalizedType, libraryDir);
    await fs.ensureDir(itemsRoot);
    const nextItems = [...(library.items || [])];

    for (const sourceFile of sourceFiles) {
      const sourcePath = path.resolve(String(sourceFile || '').trim());
      const extension = validateImportExtension(normalizedType, sourcePath);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error('Local AI Hub could not find one of the selected files anymore.');
      }
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        throw new Error('Local AI Hub can import files, not folders, into asset libraries.');
      }

      const itemId = sanitizeId(createStableId(path.basename(sourcePath, extension), 'item'), 'item');
      const managedFilename = buildManagedFilename(itemId, sourcePath);
      const targetPath = assertPathInside(itemsRoot, path.join(itemsRoot, managedFilename), 'Local AI Hub refused to copy that file outside the managed library folder.');
      await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
      const metadata = readItemMetadata(normalizedType, sourcePath);
      const timestamp = nowIso();
      nextItems.push(normalizeItemRecord(normalizedType, {
        id: itemId,
        displayName: getUniqueItemName(path.basename(sourcePath, extension), nextItems),
        originalFilename: path.basename(sourcePath),
        managedFilename,
        managedPath: `items/${managedFilename}`,
        extension,
        type: normalizedType === 'soundEffects' ? 'audio' : 'font',
        ...metadata,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }

    const updatedLibrary = await writeManifest(normalizedType, { ...library, items: nextItems });
    return { library: updatedLibrary, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

async function removeAssetLibraryItem(type, libraryId, itemId) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = normalizeLibraryType(type);
    const safeItemId = sanitizeId(itemId, 'item');
    const library = await readManifest(normalizedType, libraryId);
    const item = (library.items || []).find((entry) => entry.id === safeItemId);
    if (!item) {
      throw new Error('Local AI Hub could not find that library item.');
    }

    let nextItems = (library.items || []).filter((entry) => entry.id !== safeItemId);
    if (normalizedType !== 'colorPalettes') {
      const libraryDir = resolveLibraryDir(normalizedType, library.id);
      const itemsRoot = getItemsRoot(normalizedType, libraryDir);
      const managedFilename = path.basename(item.managedFilename || item.managedPath || '');
      const targetPath = path.resolve(path.join(itemsRoot, managedFilename));
      assertPathInside(itemsRoot, targetPath, 'Local AI Hub refused to remove a file outside the managed asset library folder.');
      if (!isPathInside(itemsRoot, targetPath)) {
        throw new Error('Local AI Hub refused to remove a file outside the managed asset library folder.');
      }
      await fs.remove(targetPath);
    }

    const updatedLibrary = await writeManifest(normalizedType, { ...library, items: nextItems });
    return { library: updatedLibrary, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

function normalizeHexColor(value) {
  const raw = String(value || '').trim();
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  const match = normalized.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) {
    throw new Error('Enter a valid hex color like #22D3EE.');
  }
  const body = match[1];
  const expanded = body.length === 3 ? body.split('').map((character) => `${character}${character}`).join('') : body;
  return `#${expanded.toUpperCase()}`;
}

async function resolveAssetLibraryItemFile(type, libraryId, itemId) {
  await ensureStorage();
  const normalizedType = normalizeLibraryType(type);
  if (normalizedType === 'colorPalettes') {
    throw new Error('Color Palette libraries use saved colors instead of files.');
  }

  const safeLibraryId = sanitizeId(libraryId, 'library');
  const safeItemId = sanitizeId(itemId, 'item');
  const library = await readManifest(normalizedType, safeLibraryId);
  const item = (library.items || []).find((entry) => entry.id === safeItemId);
  if (!item) {
    throw new Error('Local AI Hub could not find that managed asset library item.');
  }
  if (!LIBRARY_TYPES[normalizedType].supportedExtensions.has(String(item.extension || '').toLowerCase())) {
    throw new Error('Local AI Hub cannot use that asset library file type here.');
  }

  const libraryDir = resolveLibraryDir(normalizedType, library.id);
  const itemsRoot = getItemsRoot(normalizedType, libraryDir);
  const managedFilename = path.basename(item.managedFilename || item.managedPath || '');
  if (!managedFilename) {
    throw new Error('Local AI Hub could not find the managed asset file name.');
  }

  const filePath = path.resolve(path.join(itemsRoot, managedFilename));
  assertPathInside(itemsRoot, filePath, 'Local AI Hub refused to use a file outside the managed asset library folder.');
  if (!(await fs.pathExists(filePath))) {
    throw new Error('Local AI Hub could not find that managed asset file anymore.');
  }
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error('Local AI Hub can only use managed files, not folders.');
  }

  return {
    filePath,
    item,
    library: { id: library.id, name: library.name, type: normalizedType },
    libraryId: library.id,
    mimeType: getPreviewMimeType(item.extension),
    type: normalizedType,
  };
}

async function resolveAssetLibraryFontForUse(libraryId, itemId) {
  const resolved = await resolveAssetLibraryItemFile('fonts', libraryId, itemId);
  const fontFamily = readFontMetadata(resolved.filePath).fontFamily || resolved.item.fontFamily || sanitizeName(path.basename(resolved.filePath, path.extname(resolved.filePath)), '') || resolved.item.displayName;
  return {
    ...resolved,
    item: { ...resolved.item, fontFamily },
  };
}

async function resolveColorPaletteItemForUse(libraryId, itemId) {
  await ensureStorage();
  const safeLibraryId = sanitizeId(libraryId, 'library');
  const safeItemId = sanitizeId(itemId, 'item');
  const library = await readManifest('colorPalettes', safeLibraryId);
  const item = (library.items || []).find((entry) => entry.id === safeItemId);
  if (!item) {
    throw new Error('Local AI Hub could not find that color in the selected Color Palette library.');
  }
  return {
    item,
    library: { id: library.id, name: library.name, type: 'colorPalettes' },
    libraryId: library.id,
    type: 'colorPalettes',
  };
}

async function resolveAssetLibraryPreviewFile(type, libraryId, itemId) {
  const resolved = await resolveAssetLibraryItemFile(type, libraryId, itemId);
  if (!supportsPreview(resolved.type, resolved.item)) {
    throw new Error('Local AI Hub cannot preview that file type.');
  }
  return resolved;
}

function parseAssetLibraryPreviewUrl(value) {
  let parsed = null;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('Local AI Hub could not read that asset preview URL.');
  }

  if (parsed.protocol !== `${PREVIEW_URL_SCHEME}:` || parsed.hostname !== 'asset-library') {
    throw new Error('Local AI Hub refused to use an unknown asset preview URL.');
  }

  const parts = parsed.pathname.split('/').map((entry) => decodeURIComponent(entry)).filter(Boolean);
  if (parts.length !== 3) {
    throw new Error('Local AI Hub could not read that asset preview URL.');
  }

  return {
    type: parts[0],
    libraryId: parts[1],
    itemId: parts[2],
  };
}

async function resolveAssetLibraryPreviewRequest(previewUrl) {
  const request = parseAssetLibraryPreviewUrl(previewUrl);
  return resolveAssetLibraryPreviewFile(request.type, request.libraryId, request.itemId);
}

async function getAssetLibraryItemPreview(type, libraryId, itemId) {
  return queueOperation(async () => {
    const preview = await resolveAssetLibraryPreviewFile(type, libraryId, itemId);
    return {
      itemId: preview.item.id,
      libraryId: preview.libraryId,
      mimeType: preview.mimeType,
      previewKind: preview.type === 'soundEffects' ? 'audio' : 'font',
      previewUrl: buildAssetPreviewUrl(preview.type, preview.libraryId, preview.item.id),
      ...(preview.type === 'fonts' ? { fontPreviewFamily: buildFontPreviewFamily(preview.libraryId, preview.item.id) } : {}),
    };
  });
}
async function updateColorPaletteItem(libraryId, item = {}) {
  return queueOperation(async () => {
    await ensureStorage();
    const normalizedType = 'colorPalettes';
    const library = await readManifest(normalizedType, libraryId);
    const existingItems = library.items || [];
    const existingId = item?.id ? sanitizeId(item.id, 'item') : '';
    const currentItem = existingId ? existingItems.find((entry) => entry.id === existingId) : null;
    const itemId = existingId || sanitizeId(createStableId(item?.name || 'color', 'color'), 'item');
    const timestamp = nowIso();
    const nextItem = normalizeItemRecord(normalizedType, {
      ...currentItem,
      ...item,
      id: itemId,
      name: uniqueName(item?.name || currentItem?.name || 'Color', existingItems.filter((entry) => entry.id !== itemId).map((entry) => entry.name)),
      createdAt: currentItem?.createdAt || timestamp,
      updatedAt: timestamp,
    }, { touch: true });
    const nextItems = [...existingItems.filter((entry) => entry.id !== itemId), nextItem].sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    const updatedLibrary = await writeManifest(normalizedType, { ...library, items: nextItems });
    return { library: updatedLibrary, libraries: await listAssetLibrariesDirect(normalizedType) };
  });
}

module.exports = {
  LIBRARY_TYPES,
  createAssetLibrary,
  PREVIEW_URL_SCHEME,
  deleteAssetLibrary,
  getAssetLibraryItemPreview,
  importAssetLibraryItems,
  listAssetLibraries,
  normalizeHexColor,
  normalizeLibraryType,
  removeAssetLibraryItem,
  renameAssetLibrary,
  resolveAssetLibraryFontForUse,
  resolveAssetLibraryItemFile,
  resolveAssetLibraryPreviewFile,
  resolveAssetLibraryPreviewRequest,
  resolveColorPaletteItemForUse,
  resolveLibraryDir,
  updateColorPaletteItem,
  validateImportExtension,
};
