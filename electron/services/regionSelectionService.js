const MIN_REGION_SIZE = 64;
const MAX_REGION_DIMENSION = 16384;
const MAX_REGION_PIXELS = 67108864;

function toFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number.`);
  }
  return number;
}

function evenFloor(value) {
  return Math.floor(value / 2) * 2;
}

function normalizeOverlaySelection(selection, display, convertDipRect) {
  if (!display?.id || !display?.bounds || typeof convertDipRect !== 'function') {
    throw new Error('Local AI Hub could not read the selected display.');
  }

  const startX = toFiniteNumber(selection?.startX, 'Selection start X');
  const startY = toFiniteNumber(selection?.startY, 'Selection start Y');
  const endX = toFiniteNumber(selection?.endX, 'Selection end X');
  const endY = toFiniteNumber(selection?.endY, 'Selection end Y');
  const displayWidth = Number(display.bounds.width);
  const displayHeight = Number(display.bounds.height);
  if (![displayWidth, displayHeight].every(Number.isFinite) || displayWidth <= 0 || displayHeight <= 0) {
    throw new Error('Local AI Hub could not read the selected display size.');
  }

  const left = Math.max(0, Math.min(displayWidth, Math.min(startX, endX)));
  const top = Math.max(0, Math.min(displayHeight, Math.min(startY, endY)));
  const right = Math.max(0, Math.min(displayWidth, Math.max(startX, endX)));
  const bottom = Math.max(0, Math.min(displayHeight, Math.max(startY, endY)));
  const dipRect = {
    x: Number(display.bounds.x) + left,
    y: Number(display.bounds.y) + top,
    width: right - left,
    height: bottom - top,
  };
  const physicalRect = convertDipRect(dipRect);
  const x = Math.round(Number(physicalRect?.x));
  const y = Math.round(Number(physicalRect?.y));
  const width = evenFloor(Math.round(Number(physicalRect?.width)));
  const height = evenFloor(Math.round(Number(physicalRect?.height)));
  if (![x, y, width, height].every(Number.isSafeInteger)) {
    throw new Error('Local AI Hub could not convert that selection to screen coordinates.');
  }
  if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) {
    throw new Error(`Drag a region at least ${MIN_REGION_SIZE} by ${MIN_REGION_SIZE} pixels.`);
  }
  if (width > MAX_REGION_DIMENSION || height > MAX_REGION_DIMENSION || width * height > MAX_REGION_PIXELS) {
    throw new Error('That selected region is too large. Choose a smaller area.');
  }

  return {
    displayId: String(display.id),
    displayName: String(display.name || '').trim(),
    x,
    y,
    width,
    height,
  };
}

module.exports = {
  normalizeOverlaySelection,
};
