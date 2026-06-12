function buildRecordingTrayItems(activeRecording, actions = {}) {
  if (!activeRecording) {
    return [];
  }

  return [
    {
      label: `Recording: ${activeRecording.fileName || activeRecording.id || 'Active recording'}`,
      enabled: false,
    },
    {
      label: 'Stop Recording',
      click: () => actions.stopRecording?.(),
    },
    { type: 'separator' },
  ];
}

function buildTrayMenuTemplate(options = {}) {
  const recordingItems = buildRecordingTrayItems(options.activeRecording, {
    stopRecording: options.stopRecording,
  });
  const toolItems = Array.isArray(options.toolItems) && options.toolItems.length
    ? options.toolItems
    : [{ label: 'No tools installed yet', enabled: false }];

  return [
    { label: 'Open Local AI Hub', click: options.showWindow },
    { type: 'separator' },
    ...recordingItems,
    ...toolItems,
    { type: 'separator' },
    { label: 'Quit', click: options.quit },
  ];
}

function getTrayTooltip(activeRecording) {
  return activeRecording ? 'Local AI Hub - Recording in progress' : 'Local AI Hub';
}

module.exports = {
  buildRecordingTrayItems,
  buildTrayMenuTemplate,
  getTrayTooltip,
};