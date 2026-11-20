function getArtifactChoices(item) {
  return Array.isArray(item?.artifactChoices) ? item.artifactChoices.filter(Boolean) : [];
}
function getSelectedArtifactChoice(item, selectedChoiceId = '') {
  const choices = getArtifactChoices(item);
  if (!choices.length) {
    return null;
  }
  const requested = String(selectedChoiceId || '').trim();
  const requestedChoice = requested ? choices.find((choice) => choice.id === requested) : null;
  if (requestedChoice && !requestedChoice.disabled) {
    return requestedChoice;
  }
  return choices.find((choice) => choice.recommended && !choice.disabled) || choices.find((choice) => !choice.disabled) || choices[0] || null;
}
function buildSelectedCatalogItem(item, selectedChoiceId = '') {
  const selectedChoice = getSelectedArtifactChoice(item, selectedChoiceId);
  if (!selectedChoice) {
    return item;
  }
  return { ...mergeArtifactChoice(item, selectedChoice), artifactChoices: getArtifactChoices(item) };
}
function mergeArtifactChoice(item, selectedChoice) {
  const payload = selectedChoice.payload || {};
  return {
    ...item,
    ...payload,
    artifactLabel: payload.artifactLabel || selectedChoice.artifactLabel || item.artifactLabel,
    artifactPath: payload.artifactPath || selectedChoice.artifactPath || item.artifactPath,
    artifactUrl: payload.artifactUrl || selectedChoice.artifactUrl || item.artifactUrl,
    fileName: payload.fileName || selectedChoice.fileName || item.fileName,
    modelPageUrl: payload.modelPageUrl || selectedChoice.modelPageUrl || item.modelPageUrl,
    modelType: payload.modelType || selectedChoice.modelType || item.modelType,
    selectedArtifactChoice: selectedChoice,
    selectedArtifactChoiceId: selectedChoice.id,
    sizeBytes: Number(payload.sizeBytes ?? selectedChoice.sizeBytes ?? item.sizeBytes ?? 0),
    sizeLabel: selectedChoice.sizeLabel || payload.sizeLabel || null,
    sourceLabel: selectedChoice.sourceLabel || item.sourceLabel,
    sourceUrl: payload.sourceUrl || selectedChoice.modelPageUrl || item.sourceUrl,
    versionId: payload.versionId || selectedChoice.versionId || item.versionId,
    versionLabel: payload.versionLabel || selectedChoice.versionLabel || item.versionLabel,
  };
}
module.exports = { mergeArtifactChoice, getArtifactChoices, getSelectedArtifactChoice, buildSelectedCatalogItem };
