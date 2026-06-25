# Blank HyperFrames Project

This is a managed Local AI Hub HyperFrames authoring scaffold for HyperFrames 0.6.112. It is local-only, immediately renderable, and intended for hand editing or for code copied from an external AI.

- Edit visible markup in `index.html`.
- Edit layout, type, and color in `styles.css`.
- Edit the paused timeline in `script.js`.
- Keep `data-composition-id="custom-scene"` synchronized with `window.__timelines["custom-scene"]`.
- Keep `./assets/vendor/localaihub-gsap-runtime.js` before `./script.js` when using `gsap.*`.
- Copy media and fonts into `assets`; do not use remote `http`, `https`, `data:`, CDN, absolute path, or parent traversal references.

Local AI Hub provides a small GSAP-compatible runtime at `assets/vendor/localaihub-gsap-runtime.js` so generated code can use a verified local subset: `gsap.timeline`, `tl.set`, `tl.to`, `tl.from`, and `tl.fromTo`. It is not the full GSAP library and does not support plugins such as ScrollTrigger. Render through Project Input -> HyperFrames Render -> Video Output, then read lint details if validation stops.
