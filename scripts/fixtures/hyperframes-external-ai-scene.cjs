// Authored from the exported external-AI prompt, independently of the bundled scaffold.
module.exports = {
  'index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local ideas, moving</title><link rel="stylesheet" href="./styles.css"></head><body>
<main id="scene" data-composition-id="custom-scene" data-start="0" data-duration="6" data-width="1280" data-height="720">
  <div id="orbit" class="clip" data-start="0" data-duration="6" data-track-index="0"></div>
  <div id="eyebrow" class="clip" data-start="0" data-duration="6" data-track-index="1">LOCAL AI HUB / AUTHORING CHECK</div>
  <h1 id="headline" class="clip" data-start="0" data-duration="6" data-track-index="2">Your ideas.<br>Your machine.</h1>
  <div id="card" class="clip" data-start="0" data-duration="6" data-track-index="3"><b>01</b><span>CREATE LOCALLY</span><p>From a prompt to a moving scene.</p></div>
  <div id="progress" class="clip" data-start="0" data-duration="6" data-track-index="4"></div>
</main>
  <script src="./assets/vendor/localaihub-gsap-runtime.js"></script>
  <script src="./script.js"></script>
</body></html>`,
  'styles.css': `*{box-sizing:border-box}body{margin:0;background:#0a1220;font-family:Arial,sans-serif}#scene{position:relative;width:1280px;height:720px;overflow:hidden;background:#0a1220;color:#f4f8ff}#orbit{position:absolute;left:850px;top:70px;width:400px;height:400px;border-radius:50%;background:#12384c}#eyebrow{position:absolute;left:80px;top:90px;font-size:18px;letter-spacing:4px;color:#71e1d5}#headline{position:absolute;left:80px;top:145px;font-size:90px;line-height:1.05;margin:0;opacity:0}#card{position:absolute;left:800px;top:255px;width:370px;padding:35px;background:#19495c;border-radius:22px;opacity:0}#card b{display:block;font-size:80px;color:#71e1d5}#card span{font-size:19px;letter-spacing:2px}#card p{font-size:23px;line-height:1.4}#progress{position:absolute;left:80px;top:610px;width:0;height:9px;background:#71e1d5;border-radius:5px}`,
  'script.js': `window.__timelines = window.__timelines || {};
var tl = gsap.timeline({ paused: true });
tl.fromTo('#headline', {opacity:0,y:45}, {opacity:1,y:0,duration:1}, 0.2);
tl.fromTo('#card', {opacity:0,x:100}, {opacity:1,x:0,duration:1.1}, 1.1);
tl.fromTo('#orbit', {x:0,scale:0.7}, {x:-140,scale:1.35,duration:6}, 0);
tl.fromTo('#progress', {width:0}, {width:1120,duration:5.5}, 0.2);
tl.to('#card', {backgroundColor:'#27617a',duration:1.4}, 3.5);
tl.to({}, {duration:6}, 0);
window.__timelines["custom-scene"] = tl;`
};
