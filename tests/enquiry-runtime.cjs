// Native workerd + SQLite Durable Object regression. No external HTTP requests.
// NODE_PATH=<wrangler node_modules> node tests/enquiry-runtime.cjs
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  // Load the production class into a minimal harness; no delivery or external services exist here.
  const source = fs.readFileSync(require('node:path').join(__dirname,'../whatsapp-enquiry/worker.js'),'utf8');
  const start = source.indexOf('export class EnquiryUsage');
  const end = source.indexOf('\nasync function overCaps',start);
  const mf = new Miniflare(convertV4MiniflareOptions({ modules:true, script:'const CAPS={ipPerHour:6,phonePerDay:3};\n'+source.slice(start,end)+'\nexport default {fetch(){return new Response("test");}};',
    durableObjects:{ ENQ_USAGE:{className:'EnquiryUsage',useSQLite:true} }, compatibilityDate:'2026-01-01' }));
  try {
    const ns=await mf.getDurableObjectNamespace('ENQ_USAGE');
    const stub=ns.get(ns.idFromName('native-concurrency'));
    const reserve=async(i,cap=5)=>{
      const r=await stub.fetch('https://counter/reserve',{method:'POST',body:JSON.stringify({hour:'2026-10-25T14',dailyCap:cap,ip:i.toString(16).padStart(32,'0'),phone:(100+i).toString(16).padStart(32,'0'),sid:(200+i).toString(16).padStart(32,'0'),fingerprint:'f'.repeat(32)})});
      assert.equal(r.status,200);return (await r.json()).result;
    };
    const results=await Promise.all(Array.from({length:20},(_,i)=>reserve(i)));
    assert.equal(results.filter(x=>x==='').length,5);assert.equal(results.filter(x=>x==='daily_cap').length,15);
    assert.equal(await reserve(99),'daily_cap');console.log('PASS native SQLite DO: 20 concurrent reservations, exactly 5 accepted; next refused');
    const dedup=ns.get(ns.idFromName('native-dedup'));
    const claim={hour:'2026-10-26T01',dailyCap:50,ip:'a'.repeat(32),phone:'b'.repeat(32),sid:'c'.repeat(32),fingerprint:'d'.repeat(32)};
    const call=async(path,q)=>{const r=await dedup.fetch('https://counter/'+path,{method:'POST',body:JSON.stringify(q)});assert.equal(r.status,200);return r.json();};
    const parallel=await Promise.all(Array.from({length:20},()=>call('reserve',claim)));
    assert.equal(parallel.filter(r=>r.result==='').length,1);
    assert.equal(parallel.filter(r=>r.result==='in_progress').length,19);
    assert.equal((await call('settle',{...claim,outcome:{ok:true,stage:'accepted_by_whatsapp',messageId:'private'}})).result,'settled');
    assert.equal((await call('reserve',claim)).result,'duplicate');
    assert.equal((await call('reserve',{...claim,fingerprint:'e'.repeat(32)})).result,'submission_conflict');
    const failed={...claim,sid:'e'.repeat(32)};
    assert.equal((await call('reserve',failed)).result,'');
    assert.equal((await call('settle',{...failed,outcome:{ok:false,stage:'whatsapp_unavailable'}})).result,'settled');
    assert.equal((await call('reserve',failed)).result,'delivery_uncertain');
    console.log('PASS native SQLite DO: atomic duplicate claims, completed acknowledgement, conflict and uncertain lock');
    const bad=await stub.fetch('https://counter/reserve',{method:'POST',body:JSON.stringify({dailyCap:null})});assert.equal(bad.status,400);
    console.log('PASS native SQLite DO: malformed reservation refused');
  } finally { await mf.dispose(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
