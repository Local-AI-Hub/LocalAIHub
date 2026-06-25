(function () {
  var duration = 4;
  window.__timelines = window.__timelines || {};

  var tl = gsap.timeline({ paused: true });
  tl.fromTo('#scene-card', { opacity: 0, y: 38, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.9 }, 0);
  tl.fromTo('#scene-title', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.75 }, 0.25);
  tl.fromTo('#scene-caption', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7 }, 0.75);
  tl.fromTo('#scene-card', { y: 0, scale: 1 }, { y: -18, scale: 1.025, duration: 2.4 }, 1.4);
  tl.fromTo('#scene-eyebrow', { opacity: 1 }, { opacity: 0.62, duration: 1.1 }, 2.6);
  tl.to({}, { duration: duration }, 0);

  window.__timelines["custom-scene"] = tl;
  tl.seek(0);
})();
