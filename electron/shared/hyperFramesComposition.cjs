function numberInRange(value, fallback, min, max, label, integer = false) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && (!Number.isInteger(n) || n % 2))) throw new Error('HyperFrames Compose needs ' + label + ' between ' + min + ' and ' + max + (integer ? ' (even whole numbers).' : '.'));
  return n;
}
function readSceneDesigns(value) {
  if (!value) return [];
  let designs;
  try { designs = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('Scene framing must be a JSON list of scene settings.'); }
  if (!Array.isArray(designs) || designs.length > 100) throw new Error('Supply at most 100 scene designs.');
  return designs.map(design => {
    if (!design || typeof design !== 'object' || Array.isArray(design)) throw new Error('Each scene design needs an object.');
    const shapes = design.shapes || [];
    if (!Array.isArray(shapes) || shapes.length > 80) throw new Error('Use up to 80 diagram shapes per scene.');
    return {
      focusX: numberInRange(design.focusX, 50, 0, 100, 'horizontal focus'),
      focusY: numberInRange(design.focusY, 50, 0, 100, 'vertical focus'),
      startScale: numberInRange(design.startScale, 1, 1, 4, 'start zoom'),
      endScale: numberInRange(design.endScale, 1.04, 1, 4, 'end zoom'),
      shapes: shapes.map(shape => {
        if (!shape || !['line','circle','rect'].includes(shape.type)) throw new Error('Choose a line, circle, or rectangle for each diagram shape.');
        const keys = shape.type === 'line' ? ['x1','x2','y1','y2'] : shape.type === 'circle' ? ['cx','cy','r'] : ['x','y','width','height'];
        const attributes = {};
        for (const key of keys) attributes[key] = numberInRange(shape[key], 0, 0, 100, key);
        return { type: shape.type, attributes };
      }),
    };
  });
}

function normalizeSettings(config = {}) {
  const width = numberInRange(config.width,1280,64,3840,'width',true);
  const height = numberInRange(config.height,720,64,2160,'height',true);
  if (!['contain','cover'].includes(config.fitMode || 'contain')) throw new Error('Choose Contain or Cover for HyperFrames media.');
  return { sceneTemplate: config.sceneTemplate === 'illustrated' ? 'illustrated' : 'full', sceneDesigns: readSceneDesigns(config.sceneDesigns), width, height, secondsPerScene:numberInRange(config.secondsPerScene,4,0.1,600,'seconds per scene'), fitMode:config.fitMode || 'contain', title:String(config.title || 'Pipeline composition').slice(0,200), motion:config.motion !== false };
}

module.exports = { normalizeSettings };
