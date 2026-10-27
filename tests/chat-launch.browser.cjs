const {chromium}=require('playwright'),http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../site'),policy=fs.readFileSync(path.join(root,'_headers'),'utf8').match(/Content-Security-Policy: (.+)/)[1].replace('upgrade-insecure-requests','');
const server=http.createServer((q,s)=>{let p=q.url.split('?')[0];if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);if(!fs.existsSync(f)){s.writeHead(404);s.end();return;}s.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream',...(p.endsWith('.html')?{'Content-Security-Policy':policy}:{})});s.end(fs.readFileSync(f));}).listen(8918);
(async()=>{const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});try{
 for(const [lang,url] of [['en','/'],['bm','/bm/'],['zh','/zh/']]){
  for(const mode of ['success','failure']){
   const p=await b.newPage({viewport:{width:mode==='failure'?390:1200,height:844}});const errors=[];let calls=0;
   p.on('pageerror',e=>errors.push(e.message));await p.addInitScript(()=>{window.__viol=[];document.addEventListener('securitypolicyviolation',e=>window.__viol.push(e.violatedDirective));});
   await p.route(/^https?:\/\/(?!localhost)/,r=>r.abort());
   await p.route('**/ace-chat.adamteokokwei.workers.dev/chat',r=>{calls++;return r.fulfill({status:mode==='success'?200:503,contentType:'application/json',body:JSON.stringify(mode==='success'?{reply:'AI_TEST <img src=x onerror="window.__unsafe=1"> **RM1,600**'}:{error:'unavailable'})});});
   await p.route('**/ace-chat.adamteokokwei.workers.dev/summary',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({summary:'My questions: Skudai. Not paid.',model:'visitor-extract'})}));
   await p.goto('http://localhost:8918'+url);await p.click('#chatFab');await p.fill('#chatInput',({en:'Can the site explain a bakery allergy menu?',bm:'Bolehkah laman menerangkan menu alahan kedai roti?',zh:'网站能否介绍面包店的过敏原菜单？'})[lang]);await p.press('#chatInput','Enter');
   await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);assert.equal(calls,1);
   const log=await p.locator('#chatLog').innerText();if(mode==='success'){assert.ok(log.includes('AI_TEST'));assert.equal(await p.locator('#chatLog img').count(),0);assert.equal(await p.evaluate(()=>window.__unsafe),undefined);}else assert.ok(!log.includes('AI_TEST'));
   assert.ok((await p.locator('.chat-note').innerText()).includes('Google'));assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__viol),[]);
   if(mode==='success'){await p.click('#handoff');await p.waitForFunction(()=>!!document.querySelector('.wa-preview'));const a=p.locator('#chatLog a[href*="wa.me"]').last();assert.ok(decodeURIComponent(await a.getAttribute('href')).includes('Skudai. Not paid.'));}
   await p.screenshot({path:path.join(__dirname,'../'+lang+'-'+mode+'.png'),fullPage:false});console.log('PASS',lang,mode,'AI/fallback, CSP, escaping, responsive, handover');await p.close();
  }
 }
}finally{await b.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
