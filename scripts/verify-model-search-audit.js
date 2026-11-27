const assert = require('node:assert/strict');
const planner = require('../electron/services/modelDownloadPlanService');
const { createModelManager } = require('../electron/agent/modelManager.cjs');
const tool = { id: 'forge', installDir: 'test' };
const classify = (name, sizeBytes, modelType='Checkpoint') => planner.classifyArtifact(tool, { rfilename: name, sizeBytes, modelType }, 'all');
assert.equal(classify('full_v51VAE.safetensors', 4e9, 'VAE').modelType, 'Checkpoint');
assert.equal(classify('BakedVae_trainingData.zip', 4e9).runnable, false);
assert.equal(classify('placeholder.safetensors', 135).runnable, false);
assert.equal(classify('unknown.safetensors', 24655).runnable, false);
assert.equal(classify('negative.safetensors', 24655, 'Embedding').modelType, 'Embedding');
const pairs=planner.createUpscaylPackagePlans({tool:{id:'upscayl'},repositoryId:'author/upscaler'},[
 {rfilename:'NCNN/sharp.param',sizeBytes:2000},{rfilename:'NCNN/sharp.bin',sizeBytes:2000000}
]);
assert.equal(pairs[0].runnable,true);
assert.deepEqual(pairs[0].requiredArtifacts,['NCNN/sharp.param','NCNN/sharp.bin']);
async function verifySearchIntegration() {
 const t = require('../electron/services/modelService')._test;
 const originalFetch = global.fetch;
 const logger = { info: async()=>{}, warn: async()=>{} };
 const hardware = { hardware: {}, disks: [] };
 const options = {source:'huggingface',modelType:'all',taskType:'all',limit:24,sort:'most-downloaded'};
 const header = Buffer.from(JSON.stringify({emb_params:{dtype:'F32',shape:[1,768],data_offsets:[0,3072]}}));
 const data = Buffer.alloc(8 + header.length + 3072); data.writeBigUInt64LE(BigInt(header.length)); header.copy(data,8);
 let headerReads = 0;
 try {
  t.clearAllModelManagerCaches();
  global.fetch = async input => {
   const u = new URL(input);
   if (u.pathname === '/api/models/audit/embedding') return Response.json({id:'audit/embedding',tags:['lora'],siblings:[{rfilename:'negative.safetensors',size:data.length}]});
   if (u.pathname.endsWith('/negative.safetensors')) {headerReads++;return new Response(data);}
   if (u.pathname === '/api/models/audit/checkpoint') return Response.json({id:'audit/checkpoint',tags:['stable-diffusion'],siblings:[{rfilename:'Vision_V5.1.safetensors',size:4e9}]});
   return Response.json([]);
  };
  const search = query => t.searchHuggingFaceModels(tool,{...options,query},new Set(),hardware,logger);
  const embedding = await search('audit/embedding');
  assert.equal(embedding.items[0]?.modelType,'Embedding','Tensor header must override incorrect LoRA tags.');
  await search('audit/embedding'); assert.equal(headerReads,1,'Cache header verification.');
  const decimal = await search('audit/checkpoint Vision_V5.1');
  assert.equal(decimal.items[0]?.fileName,'Vision_V5.1.safetensors');
  let scans=0;
  global.fetch = async input => {
   const u=new URL(input);
   if(u.searchParams.get('expand')==='siblings') {scans++;return Response.json([], {headers:{link:'<https://huggingface.co/api/models?cursor=scan'+scans+'>; rel="next"'}});}
   return Response.json([]);
  };
  let cursor;let pages=0;
  do {
   const r=await t.searchHuggingFaceCatalog(tool,{...options,query:'audituniqueabsent',cursor},new Set(),hardware,logger);
   cursor=r.pagination.nextCursor;
   if(cursor && pages===0) {
    await assert.rejects(t.searchHuggingFaceCatalog(tool,{...options,query:'audituniqueabsent',cursor,sort:'newest'},new Set(),hardware,logger), /expired/);
    await assert.rejects(t.searchHuggingFaceCatalog(tool,{...options,query:'audituniqueabsent',cursor,includeIncompatible:true},new Set(),hardware,logger), /expired/);
   }
   assert(++pages<10,'A missing filename must not produce unbounded inventory pages.');
  }while(cursor);
  assert.equal(scans,3);

 } finally {global.fetch=originalFetch;t.clearAllModelManagerCaches();}
}
async function verifyFollowupFixes() {
 const t=require('../electron/services/modelService')._test;
 const hardware={vramMb:6144,systemRamMb:16312};
 const fit=item=>t.buildHardwareFit(item,tool,hardware);
 for(const name of ['realisticVisionV51_v51VAE.safetensors','Realistic_Vision_V5.1_noVAE.safetensors']) {
  assert.match(fit({fileName:name,modelType:'Checkpoint',sizeBytes:4e9}).message,/SD 1.5/);
 }
 assert.match(fit({fileName:'model.safetensors',modelType:'Inpainting',baseModel:'SD 1.5',description:'Try my SDXL and Flux models too',sizeBytes:2e9}).message,/SD 1.5/);
 assert.match(fit({fileName:'SDXL_vae.safetensors',modelType:'VAE',sizeBytes:3e8}).message,/support model/);
 assert.match(fit({fileName:'model.safetensors',modelType:'Checkpoint',baseModel:'SDXL 1.0',sizeBytes:2e9}).message,/SDXL/);
 const entry=(id,baseModel)=>({version:{id,name:'version',baseModel},file:{id,name:'model'+id+'.safetensors',normalizedType:'Checkpoint',modelType:'Checkpoint',sizeBytes:2e9}});
 const card=t.buildCivitaiModelResult({id:42,name:'Mixed family',description:'SDXL and Flux links'},entry(1,'SD 1.5'),tool,new Set(),{hardware,disks:[]},null,[entry(1,'SD 1.5'),entry(2,'SDXL 1.0')]);
 assert.match(card.hardwareFit.message,/SD 1.5/);
 assert.match(card.artifactChoices[1].payload.hardwareFit.message,/SDXL/);
 const originalFetch=global.fetch;
 let followedBroad=0;
 try {
  t.clearAllModelManagerCaches();
  global.fetch=async input=>{
   const u=new URL(input);
   if(u.pathname==='/api/models') {
    const q=u.searchParams.get('search')||'';
    if(u.searchParams.has('cursor') && !u.searchParams.has('expand') && /^rvc(?: |$)/.test(q)) followedBroad++;
    if(/^rvc(?: |$)/.test(q)) return Response.json([{id:'audit/unrelated'}],{headers:{link:'<https://huggingface.co/api/models?cursor=forever>; rel="next"'}});
    return Response.json([]);
   }
   if(u.pathname==='/api/models/audit/unrelated')return Response.json({id:'audit/unrelated',tags:['rvc'],siblings:[{rfilename:'unrelated.pth',size:10000000}]});
   return Response.json([]);
  };
  const rvc={id:'rvc',installDir:'test'};
  const options={query:'absent987654321',modelType:'rvc-voice',taskType:'voice-conversion',source:'huggingface',limit:24,sort:'most-downloaded'};
  const logger={info:async()=>{},warn:async()=>{}};
  let cursor,pages=0;
  do {
   const r=await t.searchHuggingFaceCatalog(rvc,{...options,cursor},new Set(),{hardware,disks:[]},logger);
   assert.equal(r.items.length,0);cursor=r.pagination.nextCursor;
   assert(++pages<=4,'Broad fallback must not keep producing empty pages.');
  }while(cursor);
  assert.equal(followedBroad,0,'Fallback catalog samples must not follow provider cursors.');
  const direct=await t.searchHuggingFaceModels(rvc,{...options,query:'rvc',limit:1},new Set(),{hardware,disks:[]},logger);
  assert(direct.pagination.nextCursor,'Explicit broad browsing must still paginate.');
 }finally{global.fetch=originalFetch;t.clearAllModelManagerCaches();}
}
async function main(){
 await verifySearchIntegration();
 await verifyFollowupFixes();
 const choices=Array.from({length:1000},(_,i)=>({id:String(i),label:'voice-'+i,recommended:i===0,payload:{fileName:'voice-'+i,sizeBytes:1000}}));
 const manager=createModelManager({models:{supportsModelManager:()=>true,getModelManagerConfig:()=>({}),browseRemoteModels:async()=>({items:[{name:'bundle',artifactChoices:choices}],pagination:{hasMore:false}})},listTools:async()=>[tool]});
 let cursor, count=0; const names=new Set();
 do { const r=await manager.search({toolId:'forge',query:'bundle',...(cursor?{cursor}:{})});
 assert(Buffer.byteLength(JSON.stringify(r))<2*1024*1024);
 for(const item of r.items)for(const c of item.choices){assert(!names.has(c.label));names.add(c.label);count++;}
 cursor=r.pagination.nextCursor;
 }while(cursor);
 assert.equal(count,1000);
 await assert.rejects(manager.search({toolId:'forge',modelType:'banana'}),/supported/);
 console.log('Exploratory search regression checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
