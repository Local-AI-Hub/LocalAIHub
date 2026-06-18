(function () {
  const duration = 5;
  const root = document.body;
  const card = document.querySelector('.title-card');
  function render(time) {
    const progress = Math.max(0, Math.min(1, time / duration));
    const intro = Math.min(1, progress * 2.8);
    const settle = Math.sin(progress * Math.PI);
    card.style.opacity = String(Math.min(1, intro + 0.05));
    card.style.transform = 'translateY(' + ((1 - intro) * 32).toFixed(2) + 'px) scale(' + (0.96 + settle * 0.04).toFixed(4) + ')';
  }
  root.classList.add('hf-ready');
  render(0);
  const timeline = {
    duration,
    totalTime: function () { return duration; },
    pause: function () {},
    seek: function (time) { render(Number(time) || 0); return this; }
  };
  window.hyperframesTimeline = timeline;
  window.__timelines = window.__timelines || {};
  window.__timelines['animated-title-card'] = timeline;
}());
