# MCP extension 0.56.1 hotfix

The extension entry point now starts its stdio listener when loaded by a hosted Node runtime through require(), as well as when executed directly. The previous require.main guard silently skipped initialization in that hosted launch mode.

A dedicated subprocess regression check covers both modes with initialize request ID 0 and without a running Hub backend. The full agent integration verifier also passes.

This is an extension-only update compatible with Local AI Hub 0.56.0. Reinstall LocalAIHub-0.56.1.mcpb in Claude Desktop; no Hub installer update is necessary. The extension version is tracked separately in electron/agent/extension-version.json. Actual Claude Desktop handshake remains to be confirmed manually.
