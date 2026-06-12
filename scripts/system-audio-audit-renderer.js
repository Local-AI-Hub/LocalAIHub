const button = document.getElementById('start-audit');
const status = document.getElementById('status');

function supportedMimeTypes() {
  return [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'audio/webm;codecs=opus',
    'audio/webm',
  ].filter((type) => MediaRecorder.isTypeSupported(type));
}

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Testing Windows loopback capture in memory...';
  let stream = null;
  let audioContext = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 320, height: 240, frameRate: 5 },
      audio: true,
    });
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    const mimeTypes = supportedMimeTypes();
    const mimeType = mimeTypes.find((type) => type.startsWith('video/webm')) || mimeTypes[0] || '';
    const chunks = [];
    let peakAudioLevel = 0;

    if (audioTracks.length) {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const sampleTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        for (const sample of samples) peakAudioLevel = Math.max(peakAudioLevel, Math.abs(sample - 128));
      }, 50);
      window.setTimeout(() => window.clearInterval(sampleTimer), 1200);
    }

    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(200);
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    let audioOnlyBlobBytes = 0;
    let audioOnlyRecorderMimeType = '';
    if (audioTracks.length) {
      const audioOnlyType = mimeTypes.find((type) => type.startsWith('audio/webm')) || '';
      const audioOnlyChunks = [];
      const audioOnlyRecorder = audioOnlyType
        ? new MediaRecorder(new MediaStream(audioTracks), { mimeType: audioOnlyType })
        : new MediaRecorder(new MediaStream(audioTracks));
      audioOnlyRecorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) audioOnlyChunks.push(event.data);
      });
      const audioOnlyStopped = new Promise((resolve) => audioOnlyRecorder.addEventListener('stop', resolve, { once: true }));
      audioOnlyRecorder.start(200);
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      audioOnlyRecorder.stop();
      await audioOnlyStopped;
      audioOnlyRecorderMimeType = audioOnlyRecorder.mimeType;
      audioOnlyBlobBytes = new Blob(audioOnlyChunks, { type: audioOnlyRecorder.mimeType }).size;
    }

    let directAudioOnlyRequest = { supported: false, errorName: '', errorMessage: '' };
    try {
      const audioOnlyRequestStream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
      directAudioOnlyRequest = { supported: audioOnlyRequestStream.getAudioTracks().length > 0, errorName: '', errorMessage: '' };
      audioOnlyRequestStream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      directAudioOnlyRequest = { supported: false, errorName: error?.name || '', errorMessage: error?.message || String(error) };
    }

    window.systemAudioAudit.report({
      ok: true,
      audioTrackCount: audioTracks.length,
      videoTrackCount: videoTracks.length,
      audioTracks: audioTracks.map((track) => ({ label: track.label, readyState: track.readyState, settings: track.getSettings() })),
      videoTracks: videoTracks.map((track) => ({ label: track.label, readyState: track.readyState, settings: track.getSettings() })),
      supportedMimeTypes: mimeTypes,
      recorderMimeType: recorder.mimeType,
      blobBytes: blob.size,
      blobType: blob.type,
      audioOnlyBlobBytes,
      audioOnlyRecorderMimeType,
      directAudioOnlyRequest,
      peakAudioLevel,
    });
  } catch (error) {
    window.systemAudioAudit.report({ ok: false, name: error?.name || '', message: error?.message || String(error) });
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => null);
  }
});
