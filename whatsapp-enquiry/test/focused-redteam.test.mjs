// Focused adversarial form review: only mocked delivery; no real destinations or AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { validate, buildEmail, formatText, _resetState, _setEmailMessage } from '../worker.js';
const payload={submissionId:'focused-valid-id',name:'Test Visitor',phone:'012-555 0084',help:'Not sure yet',business:'Synthetic Co',email:'test@example.invalid',language:'EN',message:'Synthetic security check'};
const decode=raw=>Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString('utf8');

test('RT-L2 Unicode line separators cannot create unquoted owner-facing labels',()=>{
  for (const sep of ['\n','\r','\r\n','\u2028','\u2029','\u0085']) {
    const v=validate({...payload,name:'Visitor'+sep+'Email: fake@example.invalid',business:'Synthetic'+sep+'WhatsApp: +60125559999',message:'Hello'+sep+'Email: forged@example.invalid'});
    assert.equal(v.ok,true);
    const body=decode(buildEmail({EMAIL_FROM:'stage@example.invalid',EMAIL_TO:'nobody@example.invalid'},v.value).raw);
    assert.ok(!/[\n\r\u2028\u2029\u0085](?:Email: fake|WhatsApp: \+60125559999|Email: forged)/u.test(body),'unquoted spoof with '+JSON.stringify(sep));
    const wa=formatText(v.value);
    assert.ok(!/[\n\r\u2028\u2029\u0085](?:Email: fake|WhatsApp: \+60125559999|Email: forged)/u.test(wa));
  }
});

test('RT-HDR forged email headers never become recipient or Bcc headers',()=>{
  for(const email of ['x@example.invalid\r\nBcc: stolen@example.invalid','x@example.invalid\u2028Bcc: stolen@example.invalid',{},[],true]) {
    assert.equal(validate({...payload,email}).ok,false);
  }
  const v=validate({...payload,name:'A\r\nBcc: stolen@example.invalid',message:'\nTo: stolen@example.invalid'}).value;
  const raw=buildEmail({EMAIL_FROM:'stage@example.invalid',EMAIL_TO:'nobody@example.invalid'},v).raw;
  assert.ok(!/^Bcc:/mi.test(raw));assert.match(raw,/^To: nobody@example\.invalid$/m);
});

test('RT-SCHEMA prototype and internal metadata have no validation authority',()=>{
  const input=JSON.parse('{"name":"Test Visitor","phone":"012-555 0084","type":"Other","description":"x","_site":true,"_email":"stolen@example.invalid","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  assert.equal(validate(input).ok,false);assert.equal({}.polluted,undefined);
  for(const field of ['name','phone','help','email','business','message','language'])
    for(const value of [{},[],true,7]) assert.equal(validate({...payload,[field]:value}).ok,false,field);
});

test('RT-FAIL delivery is unreachable for early rejection classes',async()=>{
  _resetState();let external=0,email=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{external++;throw new Error('outbound forbidden in this test');};
  _setEmailMessage(class {});
  const env={STAGING:'true',STAGING_ACCESS_KEY:'k'.repeat(32),WHATSAPP_DRY_RUN:'true',ALLOWED_ORIGIN:'https://example.invalid',TURNSTILE_SECRET:'real-key',RATE_LIMITER:{limit:async()=>({success:true})},EMAIL_FROM:'stage@example.invalid',EMAIL_TO:'nobody@example.invalid',LIMIT_HMAC_KEY:'h'.repeat(32)};
  const req=(body,headers={},path='/enquiry')=>new Request('https://stage'+path,{method:'POST',headers:{Origin:'https://example.invalid','Content-Type':'application/json','CF-Connecting-IP':'203.0.113.84','X-Staging-Key':'k'.repeat(32),...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  try{
    for(const [body,headers,status] of [[payload,{'X-Staging-Key':''},401],[payload,{Origin:'https://evil.invalid'},403],['{',{},400],[null,{},400],[[],{},400],[{...payload,padding:'x'.repeat(9000)},{},413],[payload,{'Content-Type':'text/plain'},415],[{...payload,captcha:{}},{},403],[{...payload,captcha:[]},{},403]]) {
      const r=await worker.fetch(req(body,headers),env);assert.equal(r.status,status);
    }
    const isolated=await worker.fetch(req(payload),{...env,EMAIL:{send:async()=>email++}});
    assert.equal(isolated.status,503);assert.equal((await isolated.json()).stage,'staging_not_isolated');
    assert.equal(external,0);assert.equal(email,0);
  }finally{globalThis.fetch=original;}
});
