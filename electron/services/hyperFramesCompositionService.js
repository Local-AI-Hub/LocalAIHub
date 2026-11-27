const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { runCommand } = require('./commandService');
const { resolveManagedFfmpegPaths } = require('./managedFfmpegService');
const { buildFileArtifact } = require('./pipelineArtifactService');
const { getHyperFramesAuthoringRuntimeSourcePath } = require('./hyperFramesProjectService');
const { assertPathInside, assertRealPathInside } = require('./pathSafetyService');
const { resolveSubtitleCaptions } = require('./mediaUtilityService');

const MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_EXTENSIONS = { image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], video: ['.mp4', '.webm', '.mov', '.mkv'], audio: ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.webm'] };
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])).replace(/:/g, '&#58;');
}
function checkCanceled(signal) {
  if (signal?.aborted) throw new Error('HyperFrames Compose was canceled.');
}
const { normalizeSettings } = require('../shared/hyperFramesComposition.cjs');
function visualItems(artifact) {
  if (artifact?.partial || artifact?.collectionStatus === 'partial') throw new Error('Complete all visual collection items before composing HyperFrames scenes. Partial collections could shift scene timing.');
  const entries = artifact?.kind === 'collection' ? artifact.items : artifact ? [{artifact}] : [];
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('HyperFrames Compose needs between 1 and 100 images or video clips.');
  return entries.map((entry,index) => {
    const item = entry?.artifact || entry;
    if (!['image','video'].includes(item?.kind)) throw new Error('HyperFrames Compose accepts image or video visuals only.');
    return { artifact:item, itemId:String(entry.itemId || 'item-' + (index+1)) };
  });
}
async function localMedia(artifact, allowedExtensions) {
  const filePath = String(artifact?.filePath || '');
  if (!filePath || !path.isAbsolute(filePath) || /^\\\\|^\/\//.test(filePath) || /[\0\r\n]/.test(filePath) || path.basename(filePath).includes(':')) throw new Error('HyperFrames Compose needs a local media file from a connected pipeline artifact.');
  if (!allowedExtensions.includes(path.extname(filePath).toLowerCase())) throw new Error('This media file type is not supported by HyperFrames Compose. Use raster images, video, audio, or SRT/VTT captions.');
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('A connected HyperFrames media file is missing or is a link. Choose the original local file.');
  await assertRealPathInside(path.dirname(filePath),filePath,'HyperFrames Compose refused a linked media file.');
  return {filePath,bytes:stat.size,extension:path.extname(filePath).toLowerCase()};
}
async function probeDuration(filePath, kind, signal) {
  checkCanceled(signal);
  const result = await runCommand(resolveManagedFfmpegPaths().ffprobePath, ['-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',filePath], {allowFailure:true,timeoutMs:30000,signal});
  let data;
  try { data=JSON.parse(result.stdout); } catch {}
  if (result.code !== 0 || !data?.streams?.some(stream=>stream.codec_type===kind)) throw new Error('A connected ' + kind + ' file could not be read. Choose a valid local media file.');
  const duration=Number(data.format?.duration || data.streams.find(stream=>stream.codec_type===kind)?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Connected media must have a readable duration of up to one hour.');
  return duration;
}
function sceneTimings(items, planArtifact, settings, narrationDuration) {
  const plan = planArtifact?.plan;
  if (planArtifact && (planArtifact.kind !== 'plan' || !Array.isArray(plan?.scenes) || !plan.scenes.length)) throw new Error('Connect a scene plan with a scenes list to HyperFrames Compose.');
  if (plan && plan.scenes.length !== items.length) throw new Error('The scene plan and visual collection must contain the same number of items, in scene order.');
  let cursor=0;
  const scenes=items.map((item,index)=>{
    const planned=plan?.scenes[index];
    const hasStart=planned?.startSeconds != null;
    const hasEnd=planned?.endSeconds != null;
    if (hasStart !== hasEnd) throw new Error('Each timed scene needs both startSeconds and endSeconds.');
    const start=hasStart ? Number(planned.startSeconds) : cursor;
    const fallback = item.duration || (narrationDuration && items.every(entry=>entry.artifact.kind==='image') ? narrationDuration/items.length : settings.secondsPerScene);
    const duration=hasEnd ? Number(planned.endSeconds)-start : planned?.durationSeconds != null ? Number(planned.durationSeconds) : fallback;
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < cursor-0.001 || duration <= 0 || start+duration>3600) throw new Error('Scene timing must be ordered, non-overlapping, positive, and no longer than one hour.');
    if (item.artifact.kind==='video' && duration > item.duration+0.1) throw new Error('A planned scene is longer than its video clip. Trim the scene timing or supply a longer clip.');
    cursor=start+duration;
    return {sceneId:String(planned?.sceneId || 'scene-'+(index+1)),itemId:item.itemId,start,duration,kind:item.artifact.kind,src:item.src};
  });
  if (narrationDuration > cursor+0.1) throw new Error('Narration is longer than the visual timeline. Extend the scene plan or provide more visual duration.');
  return {scenes,duration:cursor};
}
function parseSubtitleFile(text) {
  const cues=[];
  function seconds(value) {const parts=value.replace(',','.').split(':').map(Number); return parts.reduce((total,n)=>total*60+n,0);}
  for (const block of String(text).replace(/^\uFEFF/,'').split(/\r?\n\s*\r?\n/)) {
    const lines=block.trim().split(/\r?\n/);
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const index=lines.findIndex(line=>line.includes('-->'));
    if (index<0) { if (block.trim()) throw new Error('A subtitle cue is missing its timing line.'); continue; }
    const timing=lines[index].match(/^((?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/);
    if (!timing) throw new Error('A subtitle timing line is invalid. Use standard SRT or WebVTT timestamps.');
    cues.push({startSeconds:seconds(timing[1]),endSeconds:seconds(timing[2]),text:lines.slice(index+1).join('\n')});
  }
  if (!cues.length) throw new Error('The subtitle file has no timed captions.');
  return cues;
}
async function captionsFor(artifact, settings, duration) {
  if (!artifact) return [];
  let captions;
  if (artifact.kind==='file') {
    const source=await localMedia(artifact,['.srt','.vtt']);
    if (source.bytes>1024*1024) throw new Error('Use a subtitle file smaller than 1 MB.');
    captions=parseSubtitleFile(await fs.readFile(source.filePath,'utf8'));
  } else captions=resolveSubtitleCaptions(artifact,{captionMode:'auto',durationPerCaptionSeconds:settings.secondsPerScene,operationLabel:'HyperFrames Compose'}).captions;
  if (captions.length>1000) throw new Error('HyperFrames Compose supports up to 1,000 subtitle cues.');
  for (const cue of captions) {
    if (!Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds) || cue.startSeconds<0 || cue.endSeconds<=cue.startSeconds || cue.endSeconds>duration+0.1 || !cue.text.trim() || cue.text.length>4000) throw new Error('Subtitle cues need text and positive timing inside the visual timeline.');
  }
  return captions;
}
function buildProject(timeline,captions,narration,settings) {
  const nodes=[];
  const animation=['window.__timelines = window.__timelines || {};','var tl = gsap.timeline({ paused: true });'];
  timeline.scenes.forEach((scene,index)=>{
    const id='visual-'+index;
    const design = settings.sceneDesigns?.[index] || {focusX:50, focusY:50, startScale:1, endScale:1.04, shapes:[]};
    const illustrated = settings.sceneTemplate === 'illustrated';
    const style = 'object-position:'+design.focusX+'% '+design.focusY+'%;transform-origin:'+design.focusX+'% '+design.focusY+'%;'+(illustrated?'width:57%;':'');
    const common='style="'+style+'" id="'+id+'" class="clip visual" data-start="'+scene.start+'" data-duration="'+scene.duration+'" data-track-index="0"';
    nodes.push(scene.kind==='video' ? '<video '+common+' src="./'+scene.src+'" data-media-start="0" data-volume="0" muted playsinline preload="auto"></video>' : '<img '+common+' src="./'+scene.src+'" alt="">');
    animation.push('tl.set("#'+id+'", {opacity:1}, '+scene.start+');','tl.set("#'+id+'", {opacity:0}, '+(scene.start+scene.duration)+');');
    if(scene.kind==='image') animation.push('tl.fromTo("#'+id+'", {scale:'+design.startScale+'}, {scale:'+(settings.motion?design.endScale:design.startScale)+',duration:'+scene.duration+'}, '+scene.start+');');
    if (design.shapes.length) {
      const overlayId = 'diagram-'+index;
      const shapes = design.shapes.map(({type,attributes}) => '<'+type+' '+Object.entries(attributes).map(([key,value])=>key+'="'+value+'"').join(' ')+' />').join('');
      nodes.push('<svg id="'+overlayId+'" class="clip diagram" style="position:absolute;left:'+(illustrated?'59%':'0')+';top:0;width:'+(illustrated?'39%':'100%')+';height:100%;opacity:0" viewBox="0 0 100 100" fill="none" stroke="#467b76" stroke-width="0.9" data-start="'+scene.start+'" data-duration="'+scene.duration+'" data-track-index="3">'+shapes+'</svg>');
      animation.push('tl.set("#'+overlayId+'", {opacity:1}, '+scene.start+');','tl.set("#'+overlayId+'", {opacity:0}, '+(scene.start+scene.duration)+');');
    }
  });
  captions.forEach((cue,index)=>{
    const id='caption-'+index;
    nodes.push('<div id="'+id+'" class="clip caption" data-start="'+cue.startSeconds+'" data-duration="'+(cue.endSeconds-cue.startSeconds)+'" data-track-index="1">'+escapeHtml(cue.text)+'</div>');
    animation.push('tl.set("#'+id+'", {opacity:1}, '+cue.startSeconds+');','tl.set("#'+id+'", {opacity:0}, '+cue.endSeconds+');');
  });
  if(narration) nodes.push('<audio id="narration" class="clip" src="./'+narration.src+'" data-start="0" data-duration="'+narration.duration+'" data-track-index="2" data-volume="1" preload="auto"></audio>');
  animation.push('tl.to({}, {duration:'+timeline.duration+'}, 0);','window.__timelines["pipeline-scene"] = tl;');
  return {
    'index.html':'<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>'+escapeHtml(settings.title)+'</title><link rel="stylesheet" href="./styles.css"></head><body>\n<main id="composition" data-composition-id="pipeline-scene" data-start="0" data-duration="'+timeline.duration+'" data-width="'+settings.width+'" data-height="'+settings.height+'">\n'+nodes.join('\n')+'\n</main>\n<script src="./assets/vendor/localaihub-gsap-runtime.js"></script><script src="./script.js"></script></body></html>',
    'styles.css':'*{box-sizing:border-box}body{margin:0;background:#101827;font-family:Arial,sans-serif}#composition{position:relative;overflow:hidden;width:'+settings.width+'px;height:'+settings.height+'px;background:'+(settings.sceneTemplate==='illustrated'?'#ebd4ac':'#101827')+'}.visual{position:absolute;inset:0;width:100%;height:100%;object-fit:'+settings.fitMode+';opacity:0}.caption{position:absolute;z-index:10;left:6%;right:6%;bottom:6%;padding:12px 20px;border-radius:10px;background:rgba(0,0,0,.75);color:white;text-align:center;white-space:pre-wrap;font-size:'+Math.round(settings.height*0.045)+'px;line-height:1.3;opacity:0}',
    'script.js':animation.join('\n')
  };
}
async function composeHyperFramesProject(inputs,options={}) {
  const settings=normalizeSettings(options.config);
  const items=visualItems(inputs.visuals);
  const artifactsDir=options.runDirectories?.artifactsDir;
  if(!artifactsDir || !path.isAbsolute(artifactsDir)) throw new Error('HyperFrames Compose needs a managed pipeline artifact folder.');
  const projectRoot=path.join(artifactsDir,'hyperframes-compose-'+crypto.randomBytes(8).toString('hex'));
  assertPathInside(artifactsDir,projectRoot,'Invalid HyperFrames project output folder.');
  await fs.ensureDir(projectRoot);
  await assertRealPathInside(artifactsDir,projectRoot,'HyperFrames Compose refused a linked output folder.');
  let bytes=0;
  try {
    const copyMedia=async(artifact,name)=>{
      checkCanceled(options.cancelSignal);
      const media=await localMedia(artifact,MEDIA_EXTENSIONS[artifact.kind] || []);
      bytes+=media.bytes;
      if(bytes>MAX_BYTES) throw new Error('HyperFrames Compose supports up to 512 MB of connected media per project.');
      const src='assets/'+name+media.extension;
      await fs.ensureDir(path.join(projectRoot,'assets'));
      await fs.copyFile(media.filePath,path.join(projectRoot,src));
      return {src,duration:artifact.kind==='image' ? null : await probeDuration(path.join(projectRoot,src),artifact.kind,options.cancelSignal)};
    };
    for(let i=0;i<items.length;i++) Object.assign(items[i],await copyMedia(items[i].artifact,'visual-'+i));
    if(inputs.narration && inputs.narration.kind!=='audio') throw new Error('Connect a single narration audio artifact.');
    const narration=inputs.narration ? await copyMedia(inputs.narration,'narration') : null;
    const timeline=sceneTimings(items,inputs.plan,settings,narration?.duration || 0);
    const captions=await captionsFor(inputs.captions,settings,timeline.duration);
    const files=buildProject(timeline,captions,narration,settings);
    for(const [name,content] of Object.entries(files)) {
      if(Buffer.byteLength(content)>1024*1024) throw new Error('This composition is too large. Reduce the number or length of captions.');
      await fs.writeFile(path.join(projectRoot,name),content,'utf8');
    }
    await fs.ensureDir(path.join(projectRoot,'assets','vendor'));
    await fs.copyFile(getHyperFramesAuthoringRuntimeSourcePath(),path.join(projectRoot,'assets','vendor','localaihub-gsap-runtime.js'));
    checkCanceled(options.cancelSignal);
    const composition={schemaVersion:1,settings,durationSeconds:timeline.duration,scenes:timeline.scenes,captionCount:captions.length,narration:narration || null,scenePlanTitle:inputs.plan?.plan?.title || null};
    await fs.writeJson(path.join(projectRoot,'composition.json'),composition,{spaces:2});
    const artifact=await buildFileArtifact(path.join(projectRoot,'index.html'),{kind:'file',role:'generated',displayName:settings.title});
    artifact.hyperFramesComposition=composition;
    return {artifact,projectRoot,composition,message:'Prepared '+items.length+' HyperFrames scenes'+(narration?' with narration':'')+' and '+captions.length+' subtitle cues.'};
  } catch(error) { await fs.remove(projectRoot).catch(()=>null); throw error; }
}
module.exports={composeHyperFramesProject,normalizeSettings,_test:{visualItems,sceneTimings,parseSubtitleFile,buildProject,escapeHtml}};
