import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { counterId } from './chat-worker.js';
const origin='https://acedigitalsolutionsbiz.org';
const headers={'Origin':origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'};
test('oversized streaming body is cancelled before throttle or provider', async()=>{
 let cancelled=false,pulls=0;
 const body=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(8192));},cancel(){cancelled=true;}});
 const request=new Request('https://chat/chat',{method:'POST',headers,body,duplex:'half'});
 const r=await worker.fetch(request,{CHAT_LIMITER:{limit(){throw new Error('must not run');}}});
 assert.equal(r.status,413);assert.equal(cancelled,true);assert.ok(pulls<=6);
});
test('body read failures become a safe 400',async()=>{
 const body=new ReadableStream({start(c){c.error(new Error('private stream error'));}});
 const r=await worker.fetch(new Request('https://chat/chat',{method:'POST',headers,body,duplex:'half'}),{});
 assert.equal(r.status,400);assert.equal((await r.json()).error,'Invalid body');
});
test('wrong media and non-exact routes cannot reach provider',async()=>{
 for(const [path,type,status] of [['/chat','text/plain',415],['/other/chat','application/json',404],['/other/summary','application/json',404]]){
  const r=await worker.fetch(new Request('https://chat'+path,{method:'POST',headers:{...headers,'Content-Type':type},body:'{}'}),{});assert.equal(r.status,status);
 }
});
test('short HMAC keys fail closed',async()=>{await assert.rejects(counterId({LIMIT_HMAC_KEY:'weak'},'192.0.2.1'));});
test('provider errors cannot put echoed visitor text or credentials in logs',async()=>{
 const realFetch=globalThis.fetch,realLog=console.log,logs=[];console.log=(...a)=>logs.push(a.join(' '));
 globalThis.fetch=async()=>new Response('PRIVATE_VISITOR_TEXT SECRET_KEY_ECHO',{status:400});
 const env={GEMINI_API_KEY:'unused',LIMIT_HMAC_KEY:'h'.repeat(32),CHAT_LIMITER:{limit:async()=>({success:true})},USAGE:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({result:''})})}};
 try{
  for(const path of ['/chat']){
   const r=await worker.fetch(new Request('https://chat'+path,{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'PRIVATE_VISITOR_TEXT'}]})}),env);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE_VISITOR_TEXT|SECRET_KEY_ECHO/);
  }
  assert.doesNotMatch(logs.join('\n'),/PRIVATE_VISITOR_TEXT|SECRET_KEY_ECHO/);
 }finally{globalThis.fetch=realFetch;console.log=realLog;}
});
test('production entry ignores inherited staging/mock mode and respects AI kill switch',async()=>{
 const {default:production}=await import('./production-worker.js');
 const r=await production.fetch(new Request('https://chat/chat',{method:'POST',headers,body:'{}'}),{STAGING:'true',AI_MOCK:'true',AI_DISABLED:'true'});
 assert.equal(r.status,503);assert.equal((await r.json()).error,'unavailable');
});

test('busy, quota and timeout use only the configured free backup and reserve each attempt',async()=>{
 const original=globalThis.fetch;
 try {
  for (const failure of [503,429,'timeout']) {
   const urls=[];let reserved=0;
   globalThis.fetch=async url=>{urls.push(String(url));if(urls.length===1){if(failure==='timeout')throw new Error('timeout');return new Response('busy',{status:failure});}return Response.json({candidates:[{content:{parts:[{text:'The standard website is RM1,600.'}]}}]});};
   const env={GEMINI_API_KEY:'unused',GEMINI_MODEL:'gemini-3.1-flash-lite',GEMINI_BACKUP_MODEL:'gemini-3.5-flash-lite',LIMIT_HMAC_KEY:'h'.repeat(32),CHAT_LIMITER:{limit:async()=>({success:true})},USAGE:{idFromName:x=>x,get:()=>({fetch:async()=>{reserved++;return Response.json({result:''});}})}};
   const r=await worker.fetch(new Request('https://chat/chat',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'Website price?'}]})}),env);
   assert.equal(r.status,200);assert.equal((await r.json()).model,'gemini-3.5-flash-lite');assert.equal(reserved,2);assert.equal(urls.length,2);assert.match(urls[0],/gemini-3\.1-flash-lite/);assert.match(urls[1],/gemini-3\.5-flash-lite/);
  }
 }finally{globalThis.fetch=original;}
});

test('handover preserves visitor locations/payment status in all languages without any AI call',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must not call AI');};
 try {
  for(const [lang,text] of [['en','My bakery is in Skudai. I have not paid.'],['bm','Kedai saya di Skudai. Saya belum membayar.'],['zh','我在士姑来经营补习中心。我还没有付款，也没有确认预约。']]){
   const env={CHAT_LIMITER:{limit:async()=>({success:true})}};
   const r=await worker.fetch(new Request('https://chat/summary',{method:'POST',headers,body:JSON.stringify({lang,messages:[{role:'user',content:text},{role:'assistant',content:'Singapore, paid confirmed'}]})}),env);assert.equal(r.status,200);const j=await r.json();assert.equal(j.model,'visitor-extract');assert.ok(j.summary.includes(text));assert.doesNotMatch(j.summary,/Singapore|paid confirmed/);
  }
  assert.equal(calls,0);
 } finally {globalThis.fetch=original;}
});
