let captureConfig = null;
let mediaRecorder = null;
let sourceStream = null;
let outputStream = null;
let animationFrame = 0;
let writeQueue = Promise.resolve();
let stopping = false;
let starting = false;

const startButton = document.getElementById('start-capture');
const statusLabel = document.getElementById('status');

function chooseMimeType(includeVideo) {
  const candidates = includeVideo
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || '';
}

function stopTracks() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  for (const stream of [outputStream, sourceStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

async function buildOutputStream(displayStream, config) {
  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) throw new Error('Windows did not provide a system-audio loopback track.');
  if (!config.includeVideo) return new MediaStream(audioTracks);

  const videoTrack = displayStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('Electron did not provide the selected display video track.');
  if (config.captureTarget?.type !== 'region') {
    return new MediaStream([videoTrack, ...audioTracks]);
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([videoTrack]);
  await video.play();
  if (!video.videoWidth || !video.videoHeight) throw new Error('Electron could not read the selected display dimensions.');

  const target = config.captureTarget;
  const display = config.displayBounds;
  const scaleX = video.videoWidth / display.width;
  const scaleY = video.videoHeight / display.height;
  const sourceX = Math.max(0, (target.x - display.x) * scaleX);
  const sourceY = Math.max(0, (target.y - display.y) * scaleY);
  const sourceWidth = Math.min(video.videoWidth - sourceX, target.width * scaleX);
  const sourceHeight = Math.min(video.videoHeight - sourceY, target.height * scaleY);
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('The selected region is outside the captured display.');

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Electron could not initialize region capture.');
  const drawFrame = () => {
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    animationFrame = requestAnimationFrame(drawFrame);
  };
  drawFrame();
  const canvasStream = canvas.captureStream(config.fps || 15);
  return new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
}

async function startCapture() {
  if (!captureConfig || mediaRecorder || starting) return;
  starting = true;
  startButton.disabled = true;
  statusLabel.textContent = 'Requesting Windows loopback audio...';
  try {
    sourceStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: captureConfig.fps || 15 },
      audio: true,
    });
    outputStream = await buildOutputStream(sourceStream, captureConfig);
    const mimeType = chooseMimeType(captureConfig.includeVideo);
    mediaRecorder = mimeType ? new MediaRecorder(outputStream, { mimeType }) : new MediaRecorder(outputStream);
    const dimensions = captureConfig.includeVideo
      ? captureConfig.captureTarget?.type === 'region'
        ? { width: captureConfig.captureTarget.width, height: captureConfig.captureTarget.height }
        : (() => {
            const settings = outputStream.getVideoTracks()[0]?.getSettings() || {};
            return Number.isInteger(settings.width) && Number.isInteger(settings.height) ? { width: settings.width, height: settings.height } : null;
          })()
      : null;

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (!event.data?.size) return;
      writeQueue = writeQueue.then(async () => {
        const bytes = await event.data.arrayBuffer();
        await window.systemAudioCapture.writeChunk(bytes);
      });
    });
    mediaRecorder.addEventListener('error', (event) => {
      window.systemAudioCapture.fail({ message: event.error?.message || 'Electron MediaRecorder reported an error.', mimeType: mediaRecorder?.mimeType }).catch(() => null);
    });
    mediaRecorder.addEventListener('stop', async () => {
      try {
        await writeQueue;
        stopTracks();
        await window.systemAudioCapture.complete({ mimeType: mediaRecorder.mimeType });
      } catch (error) {
        stopTracks();
        await window.systemAudioCapture.fail({ message: error?.message || 'Electron could not save the final recording data.', mimeType: mediaRecorder?.mimeType }).catch(() => null);
      }
    }, { once: true });

    await window.systemAudioCapture.prepared();
    await new Promise((resolve) => setTimeout(resolve, 150));
    mediaRecorder.start(1000);
    await window.systemAudioCapture.started({ mimeType: mediaRecorder.mimeType, dimensions });
    statusLabel.textContent = 'Recording locally...';
  } catch (error) {
    stopTracks();
    statusLabel.textContent = 'System audio capture could not start.';
    await window.systemAudioCapture.fail({ message: error?.message || 'Electron could not start system audio capture.' }).catch(() => null);
  }
}

window.systemAudioCapture.onConfigure((config) => {
  captureConfig = config;
  statusLabel.textContent = 'Ready to start the local capture backend.';
  window.systemAudioCapture.configured().catch(() => null);
});
window.systemAudioCapture.onStop(() => {
  if (stopping) return;
  stopping = true;
  if (mediaRecorder?.state === 'recording' || mediaRecorder?.state === 'paused') {
    mediaRecorder.stop();
  } else {
    stopTracks();
    window.systemAudioCapture.fail({ message: 'Electron stopped before MediaRecorder became active.' }).catch(() => null);
  }
});
startButton.addEventListener('click', startCapture);
window.systemAudioCapture.ready().catch(() => null);
