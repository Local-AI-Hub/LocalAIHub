(function () {
  const duration = 7;
  const root = document.body;
  const words = [
    { node: document.querySelector('.word-one'), start: 0.2, x: -170 },
    { node: document.querySelector('.word-two'), start: 2.1, x: 0 },
    { node: document.querySelector('.word-three'), start: 4.0, x: 170 }
  ];
  function clamp(value) { return Math.max(0, Math.min(1, value)); }
  function render(time) {
    const t = Number(time) || 0;
    words.forEach(function (item, index) {
      const local = t - item.start;
      const intro = clamp(local / 0.6);
      const outro = clamp((2.4 - local) / 0.6);
      const visible = Math.min(intro, outro);
      const lift = Math.sin(clamp(local / 2.4) * Math.PI) * -24;
      item.node.style.opacity = String(visible);
      item.node.style.transform = 'translate(' + item.x + 'px, ' + (lift + (1 - intro) * 54).toFixed(2) + 'px) rotate(' + ((index - 1) * 2).toFixed(2) + 'deg) scale(' + (0.9 + intro * 0.1).toFixed(4) + ')';
    });
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
  window.__timelines['kinetic-text-scene'] = timeline;
}());
