# Local AI Hub

Local AI Hub is a Windows desktop app for installing, launching, and repairing local AI tools such as ComfyUI, Ollama, Automatic1111, and InvokeAI.

## Windows Install Notes

Local AI Hub is currently distributed as an unsigned Windows app. Because it is not code signed yet, Windows SmartScreen, your browser, or antivirus software may warn before the installer runs.

1. Download the latest `LocalAIHub-Setup-*.exe` release.
2. If your browser blocks the download, open the browser's downloads panel and choose `Keep anyway` if that option is shown.
3. Start the installer.
4. If Windows SmartScreen appears, click `More info`, then click `Run anyway`.
5. Finish the installation and launch Local AI Hub.

## If Security Software Interferes

Some antivirus tools may block the download, quarantine the installer, or interrupt the first launch. If that happens, confirm you downloaded the installer from the official Local AI Hub release page, then allow the installer or app in your security software before trying again.

These warnings are expected for unsigned apps and do not mean Local AI Hub is malware, but you should only continue if you trust the release source.

## Untested Features as of v0.40.0

The following features are implemented and covered by automated verification where practical, but have not yet been validated with real-world hardware, local model assets, or live cloud-provider accounts. Treat them as experimental until they are manually tested.

1. Wan 2.1 library launch on a CUDA-capable NVIDIA system
   - with required Wan model assets present

2. Local collectionMap video generation (Wan 2.1)
   - text -> video
   - image -> video
   - previous-last-frame chaining

3. Local Model Step video generation (Wan 2.1)
   - text -> video
   - image -> video

4. Cloud Model Step image generation
   - OpenAI / ChatGPT
   - Google / Gemini
   - xAI / Grok
   - text -> image
   - image -> image

5. Cloud collectionMap image generation
   - OpenAI / ChatGPT
   - Google / Gemini
   - xAI / Grok
   - text -> image
   - image -> image

6. Cloud Model Step video generation
   - Google / Gemini / Veo
   - xAI / Grok Imagine
   - text -> video
   - image -> video

7. Cloud collectionMap video generation
   - Google / Gemini / Veo
   - xAI / Grok Imagine
   - text -> video
   - image -> video
   - previous-last-frame chaining
