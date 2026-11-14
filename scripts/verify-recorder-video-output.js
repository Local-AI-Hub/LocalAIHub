const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { _test } = require('../electron/services/recordingService');
const { resolveManagedFfmpegPaths } = require('../electron/services/managedFfmpegService');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localaihub-camera-output-'));
  const { ffmpegPath, ffprobePath } = resolveManagedFfmpegPaths();
  try {
    for (const mode of ['webcam', 'webcamMic']) {
      const output = path.join(root, mode + '.mkv');
      const args = _test.buildRecordingCommand({mode,fps:60,webcam:{name:'Synthetic'},microphone:{name:'Synthetic mic'}}, output);
      // Substitute only the physical capture inputs; retain actual encoding,
      // stream mapping and simultaneous preview outputs from production code.
      const inputEnd = mode === 'webcam' ? args.indexOf('-c:v') : args.indexOf('-map');
      args.splice(2, inputEnd - 2, '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=60:duration=2', ...(mode === 'webcamMic' ? ['-f','lavfi','-i','sine=frequency=440:duration=2'] : []));
      const result = spawnSync(ffmpegPath, args, {encoding:'buffer',maxBuffer:16*1024*1024,timeout:30000,windowsHide:true});
      assert.strictEqual(result.status,0,String(result.stderr));
      const frames=[];
      const parser=_test.createJpegFrameParser(frame=>frames.push(Buffer.from(frame)));
      // Exercise real frame boundaries split across arbitrary pipe chunks.
      for(let offset=0;offset<result.stdout.length;offset+=4093) parser(result.stdout.subarray(offset,offset+4093));
      assert.strictEqual(frames.length,10,'Preview should have 5 frames per second.');
      const probe=spawnSync(ffprobePath,['-v','error','-count_frames','-show_streams','-of','json',output],{encoding:'utf8',timeout:10000,windowsHide:true});
      assert.strictEqual(probe.status,0,probe.stderr);
      const streams=JSON.parse(probe.stdout).streams;
      const video=streams.find(stream=>stream.codec_type==='video');
      assert.strictEqual(video.avg_frame_rate,'60/1');
      assert.strictEqual(Number(video.nb_read_frames),120,'Preview must not reduce recording frame count.');
      assert.strictEqual(streams.some(stream=>stream.codec_type==='audio'),mode==='webcamMic');
      console.log(mode + ': 120 recorded frames at 60 FPS, 10 preview frames at 5 FPS; audio mapping correct.');
    }
  } finally { await fs.remove(root); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
