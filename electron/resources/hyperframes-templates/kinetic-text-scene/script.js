(function () {
  const duration = 7;
  const root = document.body;
  const words = [
    { node: document.querySelector('.word-one'), start: 0.15, x: -185, rotate: -3 },
    { node: document.querySelector('.word-two'), start: 2.15, x: 0, rotate: 1 },
    { node: document.querySelector('.word-three'), start: 4.15, x: 185, rotate: 3 },
  ];

  function clamp(value) { return Math.max(0, Math.min(1, value)); }

  function renderAt(time) {
    const t = Math.max(0, Number(time) || 0);
    words.forEach(function (item) {
      const local = t - item.start;
      const intro = clamp(local / 0.55);
      const exit = clamp((2.25 - local) / 0.55);
      const visible = Math.min(intro, exit);
      const arc = Math.sin(clamp(local / 2.25) * Math.PI) * -34;
      item.node.style.opacity = String(visible);
      item.node.style.transform = 'translate(' + item.x + 'px, ' + (arc + (1 - intro) * 70 + (1 - exit) * -40).toFixed(2) + 'px) rotate(' + item.rotate + 'deg) scale(' + (0.86 + intro * 0.16).toFixed(4) + ')';
    });
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
  window.__timelines['kinetic-text-scene'] = timeline;
}());
