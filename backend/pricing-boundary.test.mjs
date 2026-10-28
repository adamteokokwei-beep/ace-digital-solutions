import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker, {PRICING_GUIDE, BUSINESS_REPLIES, approvedBusinessReply} from './chat-worker.js';
const headers={Origin:'https://acedigitalsolutionsbiz.org','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.40'};
const env=()=>({GEMINI_API_KEY:'mock-only',LIMIT_HMAC_KEY:'h'.repeat(32),CHAT_LIMITER:{limit:async()=>({success:true})},USAGE:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({result:''})})}});
const request=(lang,messages)=>new Request('https://local.invalid/chat',{method:'POST',headers,body:JSON.stringify({lang,messages})});
const asks=content=>[{role:'user',content}];
const rejected=['Yes, your website costs RM300.','Laman web lengkap berharga RM300.','The complete website costs RM300.','For your website, the total is RM300.','The full website is RM1,500, but your website costs RM300.','完整网站是RM300。','Your complete website is half a grand.','Your website is on the house.','Yes, agreed. That is correct.'];

test('all original and novel pricing bypasses are rejected through the complete Worker path in EN/BM/ZH',async()=>{
 const saved=globalThis.fetch;
 try{
  for(const lang of ['en','bm','zh']) for(const reply of rejected){
   let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({candidates:[{content:{parts:[{text:reply}]}}]});};
   const res=await worker.fetch(request(lang,asks('Explain what my bakery website could show.')),env());
   assert.equal(res.status,200);const body=await res.json();assert.notEqual(body.reply,reply);assert.doesNotMatch(body.reply,/RM300|half a grand|on the house/);assert.equal(calls,1);
   assert.match(body.reply,({en:/written quote/,bm:/sebut harga bertulis/,zh:/书面报价/})[lang]);
  }
 }finally{globalThis.fetch=saved;}
});

test('every allowed answer ID maps exactly to reviewed server text in each language',async()=>{
 const saved=globalThis.fetch;
 try{
  for(const [answer,translations] of Object.entries(BUSINESS_REPLIES))for(const lang of ['en','bm','zh']){
   let system;globalThis.fetch=async(url,options)=>{system=JSON.parse(options.body).systemInstruction.parts[0].text;return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({answer})}]}}]});};
   const body=await (await worker.fetch(request(lang,asks('Please tell me about the website.')),env())).json();assert.equal(body.reply,translations[lang]);assert.match(system,/exactly one JSON object/);
  }
 }finally{globalThis.fetch=saved;}
});

test('extra output fields, invalid JSON, unknown IDs and prototype keys cannot smuggle generated text',()=>{
 const bad=['{"answer":"pricing","text":"Your site is RM300"}','{"answer":"__proto__"}','{"answer":"constructor"}','{"answer":300}','{"answer":["pricing"]}','{"answer":"Pricing"}','{"answer":"pricing \\n"}','{"answer":"RM300"}','null','[]','300','"pricing"','```json\n{"answer":"pricing"}\n```','ＲＭ３００','R\u200bM300','免费送你网站','Only three hundred.'];
 for(const raw of bad){const result=approvedBusinessReply(raw);assert.match(result,/written quote/);assert.notEqual(result,raw);assert.ok(!Object.values(BUSINESS_REPLIES).some(v=>v.en===result));}
});

test('numeric addresses, old budgets and prior pricing cannot force unrelated later replies into pricing',async()=>{
 const saved=globalThis.fetch;
 try{
  globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:'{"answer":"business"}'}]}}]});
  for(const lang of ['en','bm','zh']){
   const messages=[{role:'user',content:'My address is 18 Jalan ABC. My budget is RM300.'},{role:'assistant',content:PRICING_GUIDE[lang]},{role:'user',content:'Can my website describe allergy information?'}];
   const body=await (await worker.fetch(request(lang,messages),env())).json();assert.equal(body.reply,BUSINESS_REPLIES.business[lang]);
  }
 }finally{globalThis.fetch=saved;}
});

test('published rates, deposit, hourly work and approved estimates remain server-owned',()=>{
 for(const guide of Object.values(PRICING_GUIDE))for(const amount of ['RM1,600','RM1,500','RM500','RM400','RM199','RM100','RM200','20%'])assert.ok(guide.includes(amount));
 for(const lang of ['en','bm','zh'])assert.equal(approvedBusinessReply('{"answer":"pricing"}',lang),PRICING_GUIDE[lang]);
});
