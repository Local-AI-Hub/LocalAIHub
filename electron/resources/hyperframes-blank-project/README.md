# Blank HyperFrames Project

This is a minimal managed scaffold for a local HTML, CSS, and JavaScript composition. It is immediately renderable and intentionally plain.

- Edit visible markup in `index.html`.
- Edit layout, type, and color in `styles.css`.
- Edit duration and deterministic motion in `script.js`.
- Copy local media and fonts into `assets` with the Local AI Hub Asset Browser.

For HyperFrames 0.6.112, `index.html` owns the composition root with `data-composition-id`, `data-width`, `data-height`, `data-start`, and `data-duration`. The linked local `script.js` initializes `window.__timelines` and registers the timeline under the same composition id. The timeline implements `pause()`, `seek(time)`, and `totalTime(time)`. Keep project references local so the editor health check and render pipeline can validate the composition.