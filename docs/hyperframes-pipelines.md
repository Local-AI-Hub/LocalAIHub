# HyperFrames in pipelines

Use **HyperFrames media scenes** in the starter templates, or connect:

`Image/video source -> HyperFrames Compose -> HyperFrames Render -> Video Output`

Compose creates a self-contained local project for each pipeline run. Connect generated images/video clips directly, or an ordered image/video collection from Collection Map or Collection Input. Your source media stays unchanged. Existing externally authored projects still use HyperFrames Project Input -> HyperFrames Render.

## Optional Compose inputs

| Input | Accepted artifact | Behavior |
| --- | --- | --- |
| Scene Plan | Plan with a `scenes` array | One scene per visual item, matched in collection order. Uses paired `startSeconds`/`endSeconds`, or `durationSeconds`. |
| Narration | One audio artifact | Starts at time zero. Join narration collections upstream before connecting. |
| Transcript / Subtitles | Transcription text, plain text, or a local SRT/VTT File Input | Transcript segments and subtitle cues retain timestamps. Plain text uses the seconds-per-scene setting for each caption. Captions must fit inside the visual timeline. |

To set timing directly, add **Plan Input** and connect its Plan output to the Scene Plan port. Through MCP, request `hub_node_types` for `planInput`, choose the scene-plan example under `configSchema.properties.plan.examples`, and set `config.plan` to your authored object. Each visual corresponds to one scene in order. For two two-second scenes, set their start/end pairs to 0/2 and 2/4 and set `timing.totalDurationSeconds` to 4. Plan Input uses the supplied scenes without a model call or estimated-narration fallback.

Without a plan, image-only scenes evenly share the narration duration when narration is connected. Otherwise images use the seconds-per-scene setting, and video scenes use each clip's natural duration. Scene plans must be ordered and non-overlapping. Video scenes can be shorter than their clips, but cannot exceed their duration. Narration longer than the visual timeline produces an actionable error rather than being silently cut off.

Video source audio is muted; the Narration input supplies the soundtrack. Compose currently provides hard scene cuts, an optional gentle image zoom, contain/cover framing, and a fixed caption style. It does not insert media into arbitrary authored HTML or synthesize missing images, narration, or subtitles. Use the existing generation, transcription, and planning nodes upstream.

Each project contains `index.html`, `styles.css`, `script.js`, local assets, the offline animation runtime, and `composition.json` with resolved timing. Compose supports 1–100 visuals, up to 512 MB of media, up to one hour of timeline, and up to 1,000 caption cues. Partial collections are rejected to preserve scene ordering.

## Verification

- `npm run verify:hyperframes-compose`: timing, input validation, local project generation, subtitle parsing, cancellation cleanup, and scheduled animation seeking.
- `node scripts/verify-hyperframes-compose.js --render`: requires the installed managed HyperFrames runtime; renders synthetic image/video/narration/caption media and checks frame differences, duration, and non-silent audio.
- `npm run verify:media-regressions`: includes a real pipeline execution through collection input, narration, text captions, and Compose.

No GUI/computer-use testing is required by these checks. The render verifier uses the runtime's headless browser as part of normal video rendering.
