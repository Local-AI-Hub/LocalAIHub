# Troubleshooting Local AI Hub

This guide covers common first checks and the information maintainers need in a useful GitHub issue.

## Before filing an issue

1. Restart Local AI Hub. If the problem continues, restart Windows once.
2. Check the [latest release](https://github.com/Local-AI-Hub/LocalAIHub/releases/latest) and note your installed version.
3. Record the exact action that failed and the plain-English message shown by the app.
4. Note whether the tool was installed by Local AI Hub or is an external/vendor installation.
5. Check free space on both `C:` and the managed storage drive.
6. Open **Settings -> Support and Diagnostics** and use **Copy system info**.
7. For repeatable failures, create and review a diagnostics bundle.

Do not share API keys, provider keys, personal access tokens (PATs), passwords, private prompts, private media, model files, generated outputs, or other sensitive data.

## Creating a diagnostics bundle

1. Open **Settings -> Support and Diagnostics**.
2. Select **Create diagnostics bundle**.
3. Select **Open diagnostics folder** when the bundle is ready.
4. Extract or open the ZIP and review every included file.
5. Attach the reviewed ZIP to the relevant GitHub issue only if you are comfortable sharing it publicly.

For a smaller summary, use **Copy system info** and paste the reviewed text into the issue form. Nothing is uploaded automatically.

## What diagnostics bundles include

Bundles include support-focused summaries of:

- Local AI Hub, Electron, Node.js, and Windows versions.
- CPU, GPU, VRAM, RAM, managed storage, and free disk space.
- Tool installation and readiness state.
- Sanitized Model Manager health: model-managed tool counts, model counts by broad type, damaged or incomplete package counts, scan warning categories, cache status, and recent local failure categories.
- Provider connection state, without provider credentials.
- Recorder availability and recent recording metadata.
- Recent pipeline run metadata and sanitized error summaries.
- Selected non-secret settings.
- A capped set of recent, sanitized Local AI Hub logs.

## What diagnostics bundles intentionally exclude

Local AI Hub does not intentionally include:

- API keys, provider keys, PATs, tokens, or passwords.
- Model files.
- Raw model filenames or full local model paths.
- Source media, recorder captures, or pipeline artifact media.
- Generated outputs.
- Prompt bodies or message contents.
- Browser data.
- Environment-variable dumps.

Redaction is a safeguard, not a substitute for review.

## Review before sharing

Open every text and JSON file in the bundle. Remove the bundle or individual content from your report if it exposes anything you do not want posted publicly. Also review screenshots and recordings for notifications, account names, filenames, conversations, and private windows.

GitHub Issues are public by default. Do not attach private media merely to demonstrate a recorder, model, or pipeline problem.

## Installer, SmartScreen, or antivirus interference

Local AI Hub is currently unsigned, so Windows SmartScreen, browsers, or antivirus software may warn about the installer.

- Download only from the official [GitHub Releases](https://github.com/Local-AI-Hub/LocalAIHub/releases) page.
- Verify that you selected the `.exe` installer, not `.blockmap` or `latest.yml`.
- If SmartScreen appears, use **More info** and continue only after verifying the source and filename.
- Check antivirus quarantine/history if the download, install, first launch, tool setup, or repair stops unexpectedly.
- Do not disable security protection broadly. If you allow a file, limit the exception to the verified installer or affected Local AI Hub path.

Mention the security product and what it blocked in your issue, but do not upload quarantined files.

## Low disk space, especially C: temp space

Tool, dependency, model, and update downloads may require temporary space in addition to their final installed size. Windows and installers can use `C:` for temporary extraction even when managed storage is on another drive.

- Check free space on `C:` and the managed storage drive.
- Clear unneeded temporary files using normal Windows storage tools.
- Remove incomplete downloads only when Local AI Hub is stopped and you know they are no longer in use.
- Retry one operation at a time and capture the exact failure message.

## Managed storage root or moving storage

Open **Settings -> Storage** to review the **Managed storage folder** and default Store install folder.

- Stop running tools before changing storage settings.
- Choose a drive with enough free space and save the storage location.
- Do not manually drag active managed tool folders between drives.
- If Local AI Hub detects older managed files, use its offered migration action instead of moving those files by hand.
- Existing external/vendor installations remain owned by their original installer unless Local AI Hub explicitly says otherwise.

If paths or tools appear missing afterward, restart Local AI Hub and include both drive free-space values in the report. Do not post your full Windows user-profile path.

## Tool install or repair fails

1. Confirm that the tool card reports the hardware as suitable enough to attempt installation.
2. Check `C:` and managed-drive free space.
3. Check antivirus history for blocked Python, Git, archive, CUDA, or tool files.
4. Close the tool and retry **Repair** once.
5. Restart Local AI Hub before repeating the install or repair.
6. Report whether the tool is Local AI Hub-managed or external/vendor-managed.

Include the tool name, exact failure step, plain-English result message, and reviewed diagnostics. Repeated repair attempts can make upstream rate limits or partial downloads harder to diagnose.

## Tool launches but is not ready

A running process may still be loading models, starting a local server, or failing an internal readiness check.

- Wait for the tool card's status and readiness message to settle.
- Stop and launch the tool once more.
- Check whether the tool's own window or console shows a safe, relevant error.
- Confirm that required models or dependencies are present.
- Use **Repair** only after recording the current message.

Do not paste a full console dump without reviewing it for paths, prompts, tokens, and private filenames.

## Model download or compatibility problem

- Confirm the model is intended for the selected tool and backend.
- Check required VRAM, RAM, disk space, model format, variant, and quantization.
- Verify free space for both the download and temporary files.
- Retry after restarting Local AI Hub if a download was interrupted.
- If Local AI Hub reports a damaged or incomplete package, download it again or delete the damaged package from Model Manager before using it.
- If a download was cancelled or failed, create a diagnostics bundle after the failure so the recent local failure category is included.
- If an integrity or preflight check fails, include the exact plain-English message and whether the failure happened before download, during transfer, or while finalizing/importing.
- If Model Manager shows scan warnings, include the warning category or text but do not paste private filenames or full local paths.
- If previews are missing, note whether the source was Hugging Face, CivitAI, Ollama, or Tabby; Local AI Hub only loads previews from its allowlisted HTTPS hosts and falls back when a preview URL is unsafe.
- Consult the upstream model/tool documentation for license or access requirements.

Never attach model files to an issue. Report the model source page, source/provider, broad model type, expected destination tool, operation involved (install, repair, download, delete, browse/search, or model discovery), and exact error instead.

## Pipeline run fails

- Note the pipeline name, failing step, tool/provider used, model variant, and whether the failure is repeatable.
- Check that every local tool in the pipeline is installed and ready.
- Check provider connection state when the pipeline intentionally uses cloud services.
- Retry with non-sensitive test input when possible.
- Create a diagnostics bundle after the failure so recent run metadata is available.

Do not share private prompts, input media, generated outputs, provider keys, or paid-account details.

## Recorder capture problem

- Record the selected mode: screen, region, system audio, microphone, webcam, or a supported combination.
- Note the display, frame rate, capture target, and audio sources.
- Use **Refresh devices** after connecting or changing microphones or webcams.
- Check Windows privacy permissions and whether another app has exclusive control of a device.
- For region capture, verify the selected display and coordinates, especially with multiple monitors.
- For system audio, note whether the Windows display-capture permission appeared.

Use a harmless test screen and audio source. Do not attach a capture containing meetings, notifications, passwords, private conversations, or confidential work.

## Fullscreen or window behavior issue

- Press `F11` to toggle the current session between fullscreen and windowed mode.
- Open **Settings -> Window behavior** and confirm the selected screen mode.
- Use **Save window settings** if the problem concerns the next launch.
- Report monitor count, scaling percentages, taskbar behavior, and whether the issue remains after restarting the app.

## Where to file reports and requests

Use [GitHub Issues](https://github.com/Local-AI-Hub/LocalAIHub/issues/new/choose) as the primary intake channel:

- Choose **Bug report** for reproducible incorrect behavior.
- Choose **Troubleshooting help** when you are blocked and need guidance.
- Choose **Feature request** for a proposed improvement.

GitHub issue forms create public repository issues; they do not email a private report directly to the maintainer. Review all content before submitting.
