(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;
  var _gsScope = root;
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function toArray(target) {
    if (!target) return [];
    if (typeof target === 'string') return Array.prototype.slice.call(document.querySelectorAll(target));
    if (target.nodeType === 1 || target === window || target === document) return [target];
    if (typeof target.length === 'number') return Array.prototype.slice.call(target);
    return [];
  }
  function numberValue(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    var parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function unitValue(value, fallbackUnit) {
    if (typeof value === 'number') return String(value) + (fallbackUnit || 'px');
    return String(value == null ? '' : value);
  }
  function splitTweenVars(vars) {
    var input = vars || {};
    var duration = Math.max(0, numberValue(input.duration, 0));
    var output = {};
    Object.keys(input).forEach(function (key) {
      if (key === 'duration' || key === 'ease' || key === 'delay' || key === 'overwrite') return;
      output[key] = input[key];
    });
    return { duration: duration, props: output };
  }
  function readProp(element, key) {
    var style = root.getComputedStyle ? root.getComputedStyle(element) : element.style;
    if (key === 'opacity') return numberValue(style.opacity, 1);
    if (key === 'x' || key === 'y' || key === 'rotation') return 0;
    if (key === 'scale' || key === 'scaleX' || key === 'scaleY') return 1;
    if (key === 'width' || key === 'height') return numberValue(style[key], 0);
    if (key === 'visibility') return style.visibility || 'visible';
    return element.style[key] || style[key] || '';
  }
  function interpolate(from, to, progress, key) {
    if (key === 'visibility') return progress >= 1 ? to : from;
    var a = numberValue(from, NaN);
    var b = numberValue(to, NaN);
    if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * progress;
    return progress >= 1 ? to : from;
  }
  function applyProps(element, props) {
    var transform = [];
    if (props.x != null || props.y != null) transform.push('translate(' + unitValue(props.x || 0, 'px') + ', ' + unitValue(props.y || 0, 'px') + ')');
    if (props.scale != null) transform.push('scale(' + numberValue(props.scale, 1) + ')');
    if (props.scaleX != null || props.scaleY != null) transform.push('scale(' + numberValue(props.scaleX, 1) + ', ' + numberValue(props.scaleY, 1) + ')');
    if (props.rotation != null) transform.push('rotate(' + unitValue(props.rotation, 'deg') + ')');
    if (transform.length) element.style.transform = transform.join(' ');
    Object.keys(props).forEach(function (key) {
      if (key === 'x' || key === 'y' || key === 'scale' || key === 'scaleX' || key === 'scaleY' || key === 'rotation') return;
      if (key === 'opacity') element.style.opacity = String(numberValue(props[key], 1));
      else if (key === 'width' || key === 'height') element.style[key] = unitValue(props[key], 'px');
      else if (key === 'visibility') element.style.visibility = String(props[key]);
      else element.style[key] = String(props[key]);
    });
  }
  function Tween(target, fromProps, toProps, start, duration) {
    this.targets = toArray(target);
    this.from = fromProps || {};
    this.to = toProps || {};
    this.start = Math.max(0, numberValue(start, 0));
    this.duration = Math.max(0, numberValue(duration, 0));
  }
  Tween.prototype.render = function (time) {
    var local = this.duration === 0 ? (time >= this.start ? 1 : 0) : clamp((time - this.start) / this.duration, 0, 1);
    var self = this;
    this.targets.forEach(function (element) {
      var next = {};
      Object.keys(self.to).forEach(function (key) {
        next[key] = interpolate(self.from[key], self.to[key], local, key);
      });
      applyProps(element, next);
    });
  };
  function Timeline() {
    this._items = [];
    this._duration = 0;
  }
  Timeline.prototype._add = function (target, fromVars, toVars, position) {
    var split = splitTweenVars(toVars);
    var start = Math.max(0, numberValue(position, this._duration));
    var tween = new Tween(target, fromVars || {}, split.props, start, split.duration);
    this._items.push(tween);
    this._duration = Math.max(this._duration, start + split.duration);
    return this;
  };
  Timeline.prototype.set = function (target, vars, position) { return this._add(target, vars || {}, vars || {}, position); };
  Timeline.prototype.to = function (target, vars, position) {
    var split = splitTweenVars(vars);
    var from = {};
    var elements = toArray(target);
    Object.keys(split.props).forEach(function (key) { from[key] = elements[0] ? readProp(elements[0], key) : split.props[key]; });
    return this._add(target, from, vars || {}, position);
  };
  Timeline.prototype.from = function (target, vars, position) {
    var split = splitTweenVars(vars);
    var to = {};
    var elements = toArray(target);
    Object.keys(split.props).forEach(function (key) { to[key] = elements[0] ? readProp(elements[0], key) : split.props[key]; });
    return this._add(target, split.props, Object.assign({}, to, { duration: split.duration }), position);
  };
  Timeline.prototype.fromTo = function (target, fromVars, toVars, position) { return this._add(target, fromVars || {}, toVars || {}, position); };
  Timeline.prototype.seek = function (time) {
    var t = Math.max(0, Math.min(this._duration || 0, numberValue(time, 0)));
    this._items.forEach(function (item) { item.render(t); });
    return this;
  };
  Timeline.prototype.pause = function (time) { if (arguments.length) this.seek(time); return this; };
  Timeline.prototype.totalTime = function (time) { if (arguments.length) { this.seek(time); return this; } return this._duration; };
  Timeline.prototype.duration = function () { return this._duration; };
  Timeline.prototype.timeScale = function () { return arguments.length ? this : 1; };
  Timeline.prototype.getChildren = function () { return this._items.slice(); };
  var gsap = {
    version: 'localaihub-0.54.0-hyperframes-0.6.112-runtime',
    timeline: function () { return new Timeline(); },
    set: function (target, vars) { var tl = new Timeline(); tl.set(target, vars, 0).seek(0); return tl; },
    to: function (target, vars) { var tl = new Timeline(); tl.to(target, vars, 0).seek(tl.duration()); return tl; },
    from: function (target, vars) { var tl = new Timeline(); tl.from(target, vars, 0).seek(0); return tl; },
    fromTo: function (target, fromVars, toVars) { var tl = new Timeline(); tl.fromTo(target, fromVars, toVars, 0).seek(0); return tl; },
    ticker: { tick: function () {} },
    config: function () {},
    defaults: function () {},
  };
  root.gsap = root.gsap || gsap;
  root.GreenSock = root.GreenSock || root.gsap;
  root._gsScope = _gsScope;
})();
