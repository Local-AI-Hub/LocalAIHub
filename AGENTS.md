###Project: NestAI — a Windows desktop app that manages local AI tools (ComfyUI, Ollama, Automatic1111) for users with mid/low-end GPUs.
Setup: Initialize an Electron + React + Tailwind CSS project in the current folder. Use electron-builder for packaging. Use the systeminformation npm package for hardware detection and python-shell for managing Python processes.
Build the following features in this order:

Hardware detection screen — on first launch, detect the user's GPU model, VRAM (MB), and system RAM using systeminformation. Display results in a clean React component and save them to a local JSON config file in the AppData folder. Show a plain-English compatibility message (e.g. "Your GTX 1060 6GB is supported in Low VRAM mode").
Environment snapshot system — when the user clicks "Save Snapshot" for any installed tool, zip that tool's virtual environment folder and config files, save it to AppData/NestAI/snapshots/[toolname]/ with a timestamp filename, and show a success notification. Add a "Restore" button that unzips a selected snapshot back into place.
Tool installer — a screen showing a grid of installable tools (ComfyUI, Ollama, Automatic1111, InvokeAI) as cards. Each card has a one-click Install button that downloads and sets up the tool in an isolated subfolder under AppData/NestAI/tools/. Show a progress bar during installation.
Home dashboard — show installed tools as cards with a status indicator (Running / Stopped / Error), a Launch/Stop button, and current VRAM + RAM usage at the top of the screen.
One-click repair — if a tool fails to launch, show a Repair button that attempts to reinstall dependencies and fix common CUDA/venv issues automatically, with a plain-English result message.
System tray — NestAI should minimize to the system tray. The tray icon should show a context menu with quick launch options for each installed tool and an option to open the full UI.

General rules:

All data stays local — no network calls except for downloading tools during install
The app should feel like native Windows software — proper window chrome, tray icon, installer via electron-builder
Every error shown to the user must be plain English, never a raw stack trace
Prioritize features in the order listed above — get each one working before moving to the next###