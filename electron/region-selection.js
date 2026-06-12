const selectionBox = document.getElementById('selection-box');
const sizeLabel = document.getElementById('selection-size');
const statusLabel = document.getElementById('status');
const cancelButton = document.getElementById('cancel-button');
let dragStart = null;
let submitting = false;

function updateSelection(startX, startY, endX, endY) {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);
  selectionBox.style.display = 'block';
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  sizeLabel.textContent = `${Math.round(width)} x ${Math.round(height)}`;
}

function resetSelection(message = '') {
  dragStart = null;
  selectionBox.style.display = 'none';
  statusLabel.textContent = message;
}

async function cancelSelection() {
  if (submitting) return;
  submitting = true;
  await window.regionSelection.cancel().catch(() => null);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelSelection();
});

cancelButton.addEventListener('click', (event) => {
  event.stopPropagation();
  cancelSelection();
});

document.addEventListener('pointerdown', (event) => {
  if (submitting || event.button !== 0 || event.target.closest('#cancel-button')) return;
  dragStart = { x: event.clientX, y: event.clientY };
  statusLabel.textContent = 'Release to use this region.';
  updateSelection(dragStart.x, dragStart.y, event.clientX, event.clientY);
});

document.addEventListener('pointermove', (event) => {
  if (!dragStart || submitting) return;
  updateSelection(dragStart.x, dragStart.y, event.clientX, event.clientY);
});

document.addEventListener('pointerup', async (event) => {
  if (!dragStart || submitting || event.button !== 0) return;
  const selection = { startX: dragStart.x, startY: dragStart.y, endX: event.clientX, endY: event.clientY };
  const width = Math.abs(selection.endX - selection.startX);
  const height = Math.abs(selection.endY - selection.startY);
  dragStart = null;
  if (width < 32 || height < 32) {
    resetSelection('That selection is too small. Drag a larger rectangle or press Esc to cancel.');
    return;
  }

  submitting = true;
  statusLabel.textContent = 'Applying selection...';
  const result = await window.regionSelection.submit(selection).catch((error) => ({ ok: false, message: error?.message }));
  if (!result?.ok) {
    submitting = false;
    resetSelection(result?.message || 'Local AI Hub could not use that selection. Try again.');
  }
});
