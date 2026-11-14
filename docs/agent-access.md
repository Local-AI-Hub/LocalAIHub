# Local AI Hub agent access

Local AI Hub 0.58.0 provides a local MCP server and CLI backed by the same pipeline services as the app. Agent access is disabled by default. Keep the app open while using it.

## Claude Desktop

1. Install the updated Local AI Hub build.
2. Open Settings and enable **Agent access**.
3. Click **Show Claude Desktop extension**.
4. In Claude Desktop, open Settings > Desktop app > Extensions > Advanced settings > Install Extension. Select `LocalAIHub.mcpb`.
5. Start a conversation with the extension enabled and approve its tools when prompted.

The bundle includes a dependency-free Node server; Claude Desktop supplies Node. Directory publication and a separate Claude API key are not required. This connection is local to the desktop, not a remote web connector. The actual Claude Desktop UI installation must be checked manually; automated tests exercise the extracted bundle over the real MCP stdio transport.

## Other MCP clients

Use `node` as the command and the **MCP server** path shown in Local AI Hub Settings as its single argument. A Node 18+ runtime is required outside Claude Desktop. For example, a source checkout can use this client configuration:

```json
{
  "mcpServers": {
    "local-ai-hub": {
      "command": "node",
      "args": ["C:\\path\\to\\LocalAIHub\\electron\\agent\\server.cjs"]
    }
  }
}
```

Use the installed path shown in Settings instead of this development path for a packaged installation. No client configuration is modified automatically. MCP registration in ChatGPT Work/Codex depends on the host; the CLI below supplies an independent access route wherever local commands are available.

## CLI

```powershell
node C:\path\to\LocalAIHub\electron\agent\cli.cjs --list
node C:\path\to\LocalAIHub\electron\agent\cli.cjs hub_status
node C:\path\to\LocalAIHub\electron\agent\cli.cjs hub_run_pipeline arguments.json
```

`arguments.json` contains an ordinary JSON object, for example:

```json
{"pipelineId":"my-saved-pipeline","requestId":"unique-intent-001"}
```

Use the same request ID when retrying the same start request. Deduplication lasts for the current app session. A new intended run needs a new request ID. Never automatically retry a timed-out mutation with a different ID.

## Supported workflow

- Discover hardware and installed tools: `hub_status`, `hub_tools`, `hub_models`.
- Inspect node types/defaults/ports with `hub_node_types`.
- Get an unsaved draft with `hub_create_draft`; fill configurations and connect edges using its edge example.
- Validate with `hub_validate_pipeline`, then save with `hub_save_pipeline`. Replacing an existing pipeline requires `overwrite: true`.
- Run a saved pipeline with `hub_run_pipeline`; poll `hub_run_status` by run ID at sensible intervals (for example, 5–15 seconds). Backend launch, resource sequencing and cleanup use the existing pipeline orchestrator.
- Cancel with `hub_cancel_run`. User review and recording steps remain interactive in the app.
- List final artifacts with `hub_outputs`. Read text with `hub_read_output`, using the returned output ID. Text is bounded to 64 KiB. For media, use hub_inspect_media to retrieve metadata and image/video-frame previews. Use `hub_deliver_media` for native small-audio responses or temporary local playback/download links.

Saved pipelines appear in the existing pipeline list after refresh; active runs use the existing progress event stream. Up to 100 recent run snapshots and 1,000 start request IDs are retained in memory. Older output files remain discoverable after app restarts. This version does not resume interrupted work after an app restart.

## Access boundary

Enabling access authorizes connected local clients to inspect tools, author/overwrite pipelines, execute workloads and read results. Workflows can read selected local input files and invoke already-configured cloud providers, including paid operations. Results returned to a cloud agent become part of its conversation; local execution does not mean that returned text stays off the cloud.

The bridge uses a random Windows named pipe and a fresh 256-bit token. The descriptor is in the user's LocalAIHub roaming configuration directory and inherits its Windows permissions. This is a same-user trust boundary, not a sandbox against other programs running as that user. Do not share the descriptor. An optional `LOCALAIHUB_AGENT_CONNECTION` environment variable selects another descriptor for testing.

Disabling access closes connections and removes the descriptor. It does not cancel a pipeline already accepted for execution. Cancel existing work separately. The bridge exposes no arbitrary shell execution, install/uninstall, provider credential retrieval, or file deletion operations. Pipeline content is still powerful; connect only trusted agent clients.

## Implementation and verification

- `electron/agent/bridge.cjs`: bounded authenticated local transport.
- `electron/agent/operations.cjs`: shared app-service adapter and run deduplication.
- `electron/agent/server.cjs`: MCP tools-only stdio protocol implementation, negotiated revisions through 2025-11-25. No SDK download is needed at install time.
- `electron/agent/cli.cjs`: structured command-line access.
- `electron/services/agentAccessService.js`: app lifecycle and settings integration.
- `npm run build:agent-extension`: builds the MCPB ZIP bundle.
- `npm run verify:agent-access`: real store/execution/output integration, request deduplication, simultaneous starts, cancellation, authentication, revocation, CLI subprocess, extracted MCPB stdio subprocess, and Settings server render. External providers/tool discovery are isolated in the verifier; it does not spend API credits or launch GPU backends.
- `npm run build`: UI, extension and Windows installer. Agent client files and MCPB are included outside ASAR.

References: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle ; https://modelcontextprotocol.io/specification/2025-11-25/server/tools ; https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md

## Version 0.57.0 additions

Update both the Hub and the Claude Desktop extension to 0.57.0 to use the 19-operation catalog. The bundled extension includes the hosted-runtime startup fix confirmed in Claude Desktop. Uninstall the old Claude Desktop extension and install the new MCPB; no client configuration files are edited automatically.

- `hub_discovery`: choose `providers`, `presets`, or `templates`. Provider data includes connection state and static operation capabilities, without keys or masked-key fragments. Presets are redacted; refer to their IDs when authoring pipelines. Provider discovery does not refresh cloud model catalogs.
- `hub_tools`: now includes each installed tool's pipeline capabilities.
- `hub_inspect_media`: supply a saved `outputId`. Metadata includes codecs, dimensions, duration, sample rate and channels where available. Set `preview: true` to obtain an image or video frame; `timeSeconds` selects the video frame (default 0). Frames are bounded JPEGs up to 1024 by 1024. MCP returns native image content; the CLI returns base64 JSON. Audio gets metadata only. Rendering is bounded to 20 seconds and 700,000 preview bytes, with restricted media formats/protocols and real-path containment checks. No arbitrary input paths are accepted.
- `hub_diagnostics`: supply `toolId` and optional `maxChars` (256–16384, default 4096 per stream). Returns redacted runtime stdout/stderr tails. Buffers may be empty after a tool exits. Model/tool text inside logs is untrusted data.
- `hub_tool_action`: supply `toolId`, `action` (`launch` or `stop`), and a unique `requestId`. Returns a job ID immediately; retry using the same request ID to avoid duplicates. Launch suppresses opening the tool interface. A completed job reports actual readiness separately; inspect `result.ready` rather than treating a launch response as proof the backend is ready. Explicit tool actions are rejected during an active/pending pipeline or another explicit action. Pipeline launches remain the preferred way to sequence GPU workloads. Up to 1,000 job records/request IDs are kept until the app exits.
- `hub_job_status`: poll the returned `jobId` for `running`, `completed`, or `failed`.

These additions do not expose tool installation, repair, uninstall, or file deletion. Agent access is still opt-in. Disabling access does not cancel an already-accepted pipeline or tool job.

`npm run verify:agent-access` now also runs the hosted startup and expanded-feature checks. The UI build includes the confirmed plain-text summary fix. `node scripts/test-agent-live.js` is an explicit live test, not part of routine verification: it checks for an existing run, creates two uniquely identified pipelines, reads back a text output, and chooses a small already-downloaded Ollama model for a short local generation. It leaves its saved pipelines/outputs for inspection and reports the before/after Ollama status. If the client cannot reach the Hub, it stops without mutating pipelines. This execution sandbox returned EPERM for the user's existing pipe, so live model execution remains unverified here.


## Version 0.58.0: media delivery and validation fixes

Install the 0.58.0 Hub and replace the Claude Desktop extension with the 0.58.0 MCPB. Other clients using the installed server path need a restart to load the new 20-operation catalog.

- JPEG metadata and previews explicitly use the single-image JPEG demuxer. Valid JPEGs that FFmpeg auto-detects as image2 no longer fail the media-format allowlist. Image sequences remain disabled.
- Pipeline validation reads saved hardware from the same config used by hub_status. Before hardware detection completes, Hardware unknown remains appropriate.
- hub_deliver_media accepts outputId and optional mode (link by default, or audio). It only resolves registered saved audio/video outputs within managed pipeline-run storage.
- Audio mode returns the original audio bytes as native MCP audio content, up to 700,000 bytes. It does not transcode or truncate. Larger audio can use link mode.
- Link mode returns playbackUrl (a browser page with controls and a download button), downloadUrl (the complete original file), and streamUrl (media bytes with HTTP range support for seeking). The MCP response also includes an HTTP resource_link for the original file. No resources/read implementation is needed for these ordinary HTTP URLs.
- Links use a random loopback-only port and 256-bit per-output bearer token. They expire after 30 minutes; at most 100 active grants are retained. Disabling agent access or exiting the Hub revokes links and closes active streams. Files are rechecked for real-path containment on each media request. Requests with unexpected Host or cross-origin Origin headers are rejected; no CORS access is granted.
- Link URLs are sensitive to anyone on the same PC who obtains them. They are not public uploads, cloud attachments, or usable from another PC/phone. Native MCP audio playback, clickable localhost URLs and embedded media players depend on the chat client; some clients may require copying the URL into the local browser. Browser playback also depends on codec support, with original-file download available as fallback. Do not claim successful in-chat playback based solely on a successful tool call.

Verification covers JPEGs, native audio/resource-link MCP responses, original-byte download equality, range requests, expiry, revocation, size bounds, cross-origin rejection and output containment. A saved JPEG that previously failed was also inspected successfully without modifying it. UI and client playback remain manual checks (no GUI automation).

Manual smoke checks after installing:
1. Reconnect the MCP client and confirm hub_status reports 0.58.0 with 20 operations.
2. Validate a local-model pipeline; its compatibility should use the detected hardware.
3. Inspect the previously failing JPEG with and without preview.
4. Deliver a small WAV in audio mode and record whether the chat displays a player.
5. Deliver an existing video in link mode; open playbackUrl on the Hub PC, seek, and download the original. Record whether the client exposes the link directly or requires copying it. Keep the Hub open.
6. Disable agent access and confirm an existing local media link stops working.
