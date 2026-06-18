(function () {
  const duration = 6;
  const root = document.body;
  const lower = document.querySelector('.lower-third');
  function clamp(value) { return Math.max(0, Math.min(1, value)); }
  function render(time) {
    const t = Number(time) || 0;
    const intro = clamp(t / 0.8);
    const outro = clamp((duration - t) / 0.6);
    const visible = Math.min(intro, outro);
    lower.style.opacity = String(visible);
    lower.style.transform = 'translateX(' + ((1 - intro) * -80).toFixed(2) + 'px)';
  }
  root.classList.add('hf-ready');
  render(0);
  const timeline = {
    duration,
    totalTime: function () { return duration; },
    pause: function () {},
    seek: function (time) { render(time); return this; }
  };
  window.hyperframesTimeline = timeline;
  window.__timelines = window.__timelines || {};
  window.__timelines['lower-third-caption'] = timeline;
}());
