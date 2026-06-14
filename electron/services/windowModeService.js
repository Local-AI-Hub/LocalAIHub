const SCREEN_MODES = Object.freeze({
  FULLSCREEN: 'fullscreen',
  WINDOWED: 'windowed',
});

function normalizeScreenMode(value) {
  return value === SCREEN_MODES.FULLSCREEN ? SCREEN_MODES.FULLSCREEN : SCREEN_MODES.WINDOWED;
}

function assertScreenMode(value) {
  if (value !== SCREEN_MODES.WINDOWED && value !== SCREEN_MODES.FULLSCREEN) {
    throw new Error('Choose either Windowed mode or Fullscreen mode.');
  }

  return value;
}

function getScreenMode(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return SCREEN_MODES.WINDOWED;
  }

  return targetWindow.isFullScreen() ? SCREEN_MODES.FULLSCREEN : SCREEN_MODES.WINDOWED;
}

function setScreenMode(targetWindow, screenMode) {
  const nextMode = assertScreenMode(screenMode);
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error('The Local AI Hub window is not available right now.');
  }

  targetWindow.setFullScreen(nextMode === SCREEN_MODES.FULLSCREEN);
  return nextMode;
}

function toggleFullscreen(targetWindow) {
  const nextMode = getScreenMode(targetWindow) === SCREEN_MODES.FULLSCREEN
    ? SCREEN_MODES.WINDOWED
    : SCREEN_MODES.FULLSCREEN;
  return setScreenMode(targetWindow, nextMode);
}

module.exports = {
  SCREEN_MODES,
  assertScreenMode,
  getScreenMode,
  normalizeScreenMode,
  setScreenMode,
  toggleFullscreen,
};
