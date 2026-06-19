(function () {
  // Edit this duration and renderAt() to change timing and motion.
  const duration = 5;
  const root = document.documentElement;
  const composition = document.querySelector('.composition');

  function clamp(value) {
    return Math.max(0, Math.min(1, value));
  }

  function renderAt(time) {
    const seconds = Math.max(0, Math.min(duration, Number(time) || 0));
    const progress = seconds / duration;
    const intro = clamp(progress * 4);
    const lift = (1 - intro) * 34 - Math.sin(progress * Math.PI) * 10;
    composition.style.opacity = String(intro);
    composition.style.transform = 'translateY(' + lift.toFixed(2) + 'px)';
    root.style.setProperty('--wash-x', (18 + progress * 60).toFixed(2) + '%');
  }

  document.body.classList.add('hf-ready');
  renderAt(0);

  // HyperFrames 0.6.112 samples this deterministic timeline during preview and render.
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
  window.__timelines.blank = timeline;
}());
