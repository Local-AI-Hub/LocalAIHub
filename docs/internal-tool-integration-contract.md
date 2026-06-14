# Internal Tool Integration Contract

## Purpose

This document is the internal maintainer contract for adding or auditing tools supported by Local AI Hub. It describes the concepts each integration must define, where those concepts currently live, and the verifier coverage expected before a tool is treated as complete.

The contract is descriptive of the 0.49.0 architecture. It does not require every concern to move into one manifest, and it does not authorize behavior changes during an audit-only pass.

## Required Integration Fields And Concepts

Every supported tool should have a reviewable answer for each item below. A field may be stored in the signed manifest, derived by a service, or documented as not applicable, but it must not be accidental.

| Concern | Required contract |
| --- | --- |
| Stable identity | A lowercase stable `id` that is safe for config keys, folders, logs, and IPC payloads. Renaming an ID is a data migration. |
| Display metadata | A non-empty `name`, `description`, `icon`, and `category` suitable for Store, Library, tray, diagnostics, and help text. |
| Install source and plan | A secure `downloadUrl` plus `installInstructions.kind`, `runtime`, summary, archive or package details, dependency steps, runtime assets, preflight checks, and compatibility guidance where relevant. |
| Managed paths | A deterministic install root under the selected Local AI Hub storage root for managed tools. Any vendor-controlled installer destination must be represented by the derived install contract. |
| Discovery | Safe `detectionPaths` and, when needed, folder names, marker paths, executable names, Python modules, or Windows uninstall metadata. |
| Launch | A safe `launchCommand`, optional external command, environment declarations, launch modes, preferred mode, process names, port, and interface mode. |
| Readiness | HTTP tools need a port/URL and a meaningful health endpoint. Desktop apps use process confirmation. Embedded CLI or worker tools use session/import/task readiness. Tool-specific post-ready probes must be named and verified. |
| Repair | Managed tools must have a deterministic reinstall or dependency rebuild path. Official installers may rerun the vendor installer. Detected external installs may explicitly have no automated repair. Errors must remain plain English. |
| Uninstall and lifecycle | The integration must resolve to managed uninstall, official Windows uninstall, or remove-from-library semantics. Dual-capability tools must keep capability ownership and shared paths safe. |
| Model directories | Model-managed tools need `modelManager.enabled`, sources, defaults, and a `targetLayout` with an owned base-path convention and directory map. |
| Model compatibility | Artifact classification, package plans, allowed model/task filters, and special companion-file requirements must be covered when generic model placement is insufficient. |
| Pipeline capabilities | Pipeline-capable tools need a strategy plus typed operation capabilities, or a graph workflow contract with explicit typed input/output boundaries. Non-pipeline tools should remain absent by design. |
| Artifact types | Pipeline operations must declare accepted input kinds and produced output kinds. Runtime services must preserve those types and lineage when artifacts are saved. |
| UI and help text | Store and Library labels, install summaries, mode labels, compatibility messages, and repair/readiness errors must be understandable without reading logs. |
| Diagnostics | Generic tool diagnostics must expose stable ID, lifecycle, launch mode, status, readiness/repair state, and sanitized errors without secrets or uncontrolled paths. |
| Verifier coverage | Structural manifest checks plus focused launch, readiness, repair, model, lifecycle, pipeline, and diagnostics verifiers appropriate to the integration's risk. |

## Current Architecture Map

| Concern | Current owner(s) |
| --- | --- |
| Signed catalog and base metadata | `electron/config/tools-manifest.json`, its detached signature, `electron/services/manifestService.js`, and `scripts/sign-tools-manifest.js` |
| Normalized internal registry and Store projection | `electron/services/toolRegistry.js`; it derives launch URLs/modes, discovery defaults, install contracts, process names, model metadata, and pipeline capability summaries |
| Install-plan execution and repair | `electron/services/installerService.js`, with Python/runtime helpers and tool-specific final readiness checks |
| Managed root and path safety | `electron/services/configService.js`, `electron/services/storageLocationService.js`, `electron/services/pathSafetyService.js`, and managed-path helpers in the installer/discovery services |
| Lifecycle and UI action semantics | `electron/services/toolLifecycleService.js`; Windows uninstall reconciliation is in `electron/services/windowsUninstallService.js` |
| Discovery and installed-state reconciliation | `electron/services/toolDiscoveryService.js` and `electron/services/toolStateService.js` |
| Launch profiles, process lifecycle, and common readiness polling | `electron/services/toolRegistry.js` and `electron/services/processService.js` |
| Runtime recovery diagnosis | `electron/services/runtimeRecoveryService.js` plus tool-specific launch/readiness services and verifier scripts |
| Model directory resolution and catalog/download execution | `electron/services/modelService.js` |
| Model artifact compatibility and package planning | `electron/services/modelDownloadPlanService.js`; several families still use explicit tool-ID classification branches |
| Pipeline tool strategy and typed operations | `electron/shared/pipelineCapabilities.cjs` |
| Graph-native workflow boundaries | `electron/shared/graphWorkflowContracts.cjs` for ComfyUI and InvokeAI |
| Pipeline node and port contracts | `electron/shared/pipelineSchema.cjs`; execution and artifact persistence are in `electron/services/pipelineExecutionService.js` and `electron/services/pipelineArtifactService.js` |
| Provider/tool readiness reconciliation for runs | `electron/services/pipelineToolOrchestrationService.js`, provider services, and context-map analysis in the pipeline schema |
| UI labels and help | Manifest summaries plus `src/components/StoreCard.jsx`, `src/components/LibraryCard.jsx`, `src/lib/tool-ui.js`, and tool-specific panels |
| Diagnostics | `electron/services/diagnosticsService.js` builds a generic sanitized tool summary; `scripts/verify-diagnostics-support.js` verifies the bounded surface |
| Existing verification | `verify:manifest`, `verify:launch-modes`, `verify-managed-launch-storage.js`, `verify-model-download-plans.js`, focused tool readiness scripts, lifecycle/uninstall scripts, pipeline verifiers, and diagnostics verification |

The signed manifest is the catalog source of truth, but it is not the whole integration contract. Registry normalization supplies defaults, and specialized services own behavior that cannot yet be represented declaratively.

## Integration Checklist

1. Choose a stable tool ID and search the repo for collisions or old aliases.
2. Add complete display, category, download, install, compatibility, and discovery metadata to the signed manifest.
3. Confirm registry normalization produces the expected install contract, launch modes, URLs, process names, and Store projection.
4. Verify managed, official-installer, and detected-external ownership semantics before implementing install, repair, or uninstall behavior.
5. Define the managed install path and any model roots; prove every destructive operation remains inside an owned root.
6. Define launch commands and all supported modes. Add an HTTP health path, process confirmation, or an explicit embedded/session readiness mechanism.
7. Add plain-English launch failure and repair outcomes. Keep raw output in logs only.
8. For model-managed tools, define sources, defaults, target layout, allowed filters, compatibility rules, package companions, and repair/uninstall preservation behavior.
9. For pipeline tools, register a strategy and typed operations. For graph-native tools, register graph boundaries and runnable adapter status.
10. Confirm pipeline orchestration can reconcile installed state, launch the tool when appropriate, wait for readiness, and release it safely.
11. Confirm Store, Library, tray, model, pipeline, and diagnostics surfaces use the intended labels and do not invent separate identity rules.
12. Add focused verifier coverage and run the shared contract, manifest, launch-mode, managed-storage, model-plan, diagnostics, UI build, and package build checks.
13. Re-sign the tool manifest only when manifest content changes and only through the project signing process.

## Known Gaps And Follow-Up Recommendations

- Readiness ownership is split between manifest health metadata, registry overrides, generic process polling, installer finalization probes, and tool-specific services. A future internal readiness descriptor could make the selected mechanism and verifier easier to discover without changing runtime behavior.
- `toolRegistry.js` contains discovery defaults and special readiness adjustments, so the signed manifest is not a complete standalone picture of an integration.
- Repair and post-install verification are concentrated in the large installer service and include tool-ID branches. Small internal strategy helpers could improve ownership when another tool needs the same pattern.
- Model placement is declarative, but artifact compatibility and package planning remain partly keyed by tool family in `modelDownloadPlanService.js`. New model families need both manifest metadata and service/verifier work.
- Pipeline strategy/capability registration is separate from graph workflow contracts and from manifest metadata. The separation is useful, but omissions are currently found mainly through focused verifiers and maintainer knowledge.
- Desktop and embedded tools do not use one uniform readiness shape. Their process/session/import confirmation is valid, but the reason is derived from interface mode rather than declared in one explicit field.
- Generic diagnostics include every reconciled tool, but there is no per-tool declaration of additional sanitized diagnostic facts. Add such facts only when a concrete support need exists.
- Verifier coverage is broad but distributed. The lightweight contract verifier reports structural and discoverability gaps; it intentionally does not replace focused runtime verifiers.

## What This Is Not

- Not a public plugin SDK.
- Not a promise of stable external APIs or manifest compatibility.
- Not a third-party extension or runtime plugin loading system.
- Not a plugin marketplace, signing policy, sandbox, or permission model.
- Not a requirement to migrate every existing integration into a new registry architecture.

## Audit Exceptions

The lightweight verifier treats the following as intentional, documented shapes rather than missing HTTP readiness metadata:

- Desktop apps (`lmstudio`, `gpt4all`, `jan`, `opencode`, and `upscayl`) use process or vendor-app launch confirmation.
- Embedded tools (`whisper` and `aider`) use task, import, or interactive session readiness rather than an HTTP endpoint.
- Tools absent from pipeline capability registration are not pipeline-capable by default. Pipeline support must be explicitly added; Store presence alone does not imply it.