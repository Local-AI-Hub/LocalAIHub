(function () {
  const duration = 6;
  const root = document.body;
  const lower = document.querySelector('.lower-third');

  function clamp(value) { return Math.max(0, Math.min(1, value)); }

  function renderAt(time) {
    const t = Math.max(0, Number(time) || 0);
    const intro = clamp(t / 0.75);
    const exit = clamp((duration - 1.05 - t) / 0.65);
    const visible = Math.min(intro, exit);
    lower.style.opacity = String(visible);
    lower.style.transform = 'translateX(' + ((1 - intro) * -120 + (1 - exit) * 120).toFixed(2) + 'px)';
  }

  root.classList.add('hf-ready');
  renderAt(0);

  // HyperFrames 0.6.112 samples registered timelines through totalTime(time).
  const timeline = {
    duration,
    pause: function () { return this; },
    seek: function (time) { renderAt(time); return this; },
    totalTime: function (time) {
      if (arguments.length > 0) {
        renderAt(time);
        return this;
      }
      return duration;
    },
  };

  window.hyperframesTimeline = timeline;
  window.__timelines = window.__timelines || {};
  window.__timelines['lower-third-caption'] = timeline;
}());
