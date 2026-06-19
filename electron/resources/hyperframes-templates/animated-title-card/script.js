(function () {
  const duration = 5;
  const root = document.body;
  const card = document.querySelector('.title-card');

  function clamp(value) { return Math.max(0, Math.min(1, value)); }

  function renderAt(time) {
    const progress = clamp((Number(time) || 0) / duration);
    const intro = clamp(progress * 3.1);
    const drift = Math.sin(progress * Math.PI);
    const bgShift = Math.round(18 + progress * 28);
    card.style.opacity = String(clamp(intro));
    card.style.transform = 'translateY(' + ((1 - intro) * 42 - progress * 16).toFixed(2) + 'px) scale(' + (0.94 + drift * 0.07).toFixed(4) + ')';
    root.style.setProperty('--title-glow-x', bgShift + '%');
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
  window.__timelines['animated-title-card'] = timeline;
}());
