function numberInRange(value, fallback, min, max, label, integer = false) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && (!Number.isInteger(n) || n % 2))) throw new Error('HyperFrames Compose needs ' + label + ' between ' + min + ' and ' + max + (integer ? ' (even whole numbers).' : '.'));
  return n;
}
function normalizeSettings(config = {}) {
  const width = numberInRange(config.width,1280,64,3840,'width',true);
  const height = numberInRange(config.height,720,64,2160,'height',true);
  if (!['contain','cover'].includes(config.fitMode || 'contain')) throw new Error('Choose Contain or Cover for HyperFrames media.');
  return { width, height, secondsPerScene:numberInRange(config.secondsPerScene,4,0.1,600,'seconds per scene'), fitMode:config.fitMode || 'contain', title:String(config.title || 'Pipeline composition').slice(0,200), motion:config.motion !== false };
}

module.exports = { normalizeSettings };
