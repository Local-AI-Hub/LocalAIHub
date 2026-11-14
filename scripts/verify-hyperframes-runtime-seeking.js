const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync(require('../electron/services/hyperFramesProjectService').getHyperFramesAuthoringRuntimeSourcePath(),'utf8');
const caption={nodeType:1,style:{opacity:'0'}};
const sandbox={document:{querySelectorAll:()=>[caption]},getComputedStyle:element=>element.style};
sandbox.window=sandbox;
vm.runInNewContext(source,sandbox);
const tl=sandbox.gsap.timeline({paused:true});
tl.set('#caption',{opacity:1},1).set('#caption',{opacity:0},2).to({}, {duration:3},0);
for(const [time,opacity] of [[0,'0'],[1.5,'1'],[2.5,'0'],[1.5,'1'],[0,'0'],[2,'0'],[1,'1']]) {
  tl.seek(time);assert.strictEqual(caption.style.opacity,opacity,'Scheduled caption at '+time);
}
const simultaneous=sandbox.gsap.timeline();
simultaneous.set('#caption',{opacity:1},0).set('#caption',{opacity:0},0).seek(0);
assert.strictEqual(caption.style.opacity,'0','Same-time sets retain insertion order.');
console.log('HyperFrames scheduled-set seek verification passed.');
