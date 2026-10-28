const {chromium}=require('playwright'),http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../site'),policy=fs.readFileSync(path.join(root,'_headers'),'utf8').match(/Content-Security-Policy: (.+)/)[1].replace('upgrade-insecure-requests','');
const server=http.createServer((q,s)=>{let p=q.url.split('?')[0];if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);if(!fs.existsSync(f)){s.writeHead(404);s.end();return;}s.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream',...(p.endsWith('.html')?{'Content-Security-Policy':policy}:{})});s.end(fs.readFileSync(f));}).listen(8918);
(async()=>{const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});try{
 for(const [lang,url] of [['en','/'],['bm','/bm/'],['zh','/zh/']]){
  for(const mode of ['success','failure']){
   const p=await b.newPage({viewport:{width:mode==='failure'?390:1200,height:844}});const errors=[];let calls=0, summaries=0;
   p.on('pageerror',e=>errors.push(e.message));await p.addInitScript(()=>{window.__opened=[];window.open=(url)=>{window.__opened.push(url);return null;};const nativeTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms>=1800&&ms<=2700?0:ms,...args);window.__viol=[];document.addEventListener('securitypolicyviolation',e=>window.__viol.push(e.violatedDirective));});
   await p.route(/^https?:\/\/(?!localhost)/,r=>r.abort());
   await p.route('**/ace-chat.adamteokokwei.workers.dev/chat',r=>{calls++;return r.fulfill({status:mode==='success'?200:503,contentType:'application/json',body:JSON.stringify(mode==='success'?{reply:'AI_TEST <img src=x onerror="window.__unsafe=1"> **RM1,600**'}:{error:'unavailable'})});});
   await p.route('**/ace-chat.adamteokokwei.workers.dev/summary',r=>{summaries++;return r.abort();});
   await p.goto('http://localhost:8918'+url);await p.click('#chatFab');await p.fill('#chatInput',({en:'Can the site explain a bakery allergy menu?',bm:'Bolehkah laman menerangkan menu alahan kedai roti?',zh:'网站能否介绍面包店的过敏原菜单？'})[lang]);await p.press('#chatInput','Enter');
   await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);assert.equal(calls,1);
   const log=await p.locator('#chatLog').innerText();if(mode==='success'){assert.ok(log.includes('AI_TEST'));assert.equal(await p.locator('#chatLog img').count(),0);assert.equal(await p.evaluate(()=>window.__unsafe),undefined);}else assert.ok(!log.includes('AI_TEST'));
   assert.ok((await p.locator('.chat-note').innerText()).includes('Google'));assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);assert.deepEqual(await p.evaluate(()=>window.__viol),[]);
   const expected=await p.locator('#chatLog .msg').allInnerTexts();
   await p.click('#handoff');
   const opened=await p.evaluate(()=>window.__opened);const exported=await p.locator('#chatExport').isVisible();assert.equal(opened.length,exported?0:1);
   const target=new URL(exported?await p.locator('#openWhatsApp').getAttribute('href'):opened[0]);assert.ok(target.href.length<=1800);assert.equal(target.origin,'https://wa.me');assert.equal(target.pathname,'/60102641824');
   const conversation=exported?await p.locator('#chatExportText').inputValue():target.searchParams.get('text');for(const message of expected)assert.ok(conversation.includes(message.trim().replace(/[\r\n\u0085\u2028\u2029]+/g,'\n> ')),lang+': full visible message retained');
   assert.ok(conversation.includes(({en:'Visitor:',bm:'Pelawat:',zh:'访客:'})[lang]));
   assert.ok(conversation.includes(({en:'Assistant (automated, not a quote):',bm:'Pembantu (automatik, bukan sebut harga):',zh:'助手（自动回复，并非报价）:'})[lang]));
   assert.equal(summaries,0);assert.equal(await p.locator('.wa-preview').count(),0);
   if(lang==='en'&&mode==='success'){
    for(let i=0;i<22;i++){
     await p.fill('#chatInput','Conversation turn '+i+' '+('x'.repeat(680))+' END_'+i);
     await p.press('#chatInput','Enter');await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);
    }
    await p.click('#handoff');assert.ok(await p.locator('#chatExport').isVisible());const full=await p.locator('#chatExportText').inputValue();
    assert.ok(full.includes('Conversation turn 0 '+('x'.repeat(680))+' END_0'));
    assert.ok(full.includes('END_21'));assert.ok(full.includes('AI_TEST'));
    assert.ok((full.match(/Visitor:/g)||[]).length>=23,'all turns retained beyond old 40-message cap');
    await p.click('#chatReset');await p.click('#chatLog .q-wa');
    const reset=await p.locator('#chatExport').isVisible()?await p.locator('#chatExportText').inputValue():new URL((await p.evaluate(()=>window.__opened)).at(-1)).searchParams.get('text');
    assert.ok(!reset.includes('END_0'),'reset clears the prior conversation');
    await p.getByRole('button',{name:'Estimate my cost',exact:true}).click();await p.waitForSelector('[data-use]');
    await p.locator('[data-use]').click();const estimate=await p.locator('#chatExport').isVisible()?await p.locator('#chatExportText').inputValue():new URL((await p.evaluate(()=>window.__opened)).at(-1)).searchParams.get('text');
    assert.ok(estimate.includes('RM200 to start, RM1,400 before launch'));assert.ok(estimate.includes('Estimated total'));assert.ok(estimate.includes('RM1,600'));assert.ok(estimate.includes('Estimate I saw:'));
    await p.fill('#chatInput','cost only website care');await p.press('#chatInput','Enter');await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);
    const empty= p.locator('.calc').last();assert.ok((await empty.locator('.tot').innerText()).includes('Tick at least one item'));assert.ok(await empty.locator('[data-use]').isDisabled());
   }
   // A long CJK/emoji conversation stays intact without an oversized WhatsApp URL.
   await p.fill('#chatInput',('中文😀'.repeat(150))+' LONG_END');await p.press('#chatInput','Enter');await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);
   const before=(await p.evaluate(()=>window.__opened)).length;await p.click('#handoff');
   assert.equal((await p.evaluate(()=>window.__opened)).length,before,'long chat does not launch an oversized link');
   const transcript=await p.locator('#chatExportText').inputValue();assert.ok(transcript.includes('LONG_END'));assert.ok(transcript.includes('中文😀'.repeat(150)));
   assert.ok((await p.locator('#openWhatsApp').getAttribute('href')).length<=1800);
   await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}}));
   await p.click('#copyFullChat');assert.equal(await p.evaluate(()=>window.__copied),transcript);
   await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}}));
   await p.click('#copyFullChat');assert.equal(await p.locator('#chatExportText').evaluate(el=>el.value.substring(el.selectionStart,el.selectionEnd)),transcript,'manual copy fallback selects full transcript');
   const download=await Promise.all([p.waitForEvent('download'),p.click('#downloadFullChat')]).then(x=>x[0]);
   assert.equal(download.suggestedFilename(),'ace-website-chat.txt');assert.equal(fs.readFileSync(await download.path(),'utf8'),transcript);
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await p.screenshot({path:path.join(__dirname,'../'+lang+'-'+mode+'.png'),fullPage:false});
   await p.click('#chatReset');assert.equal(await p.locator('#chatExportText').inputValue(),'');assert.ok(!await p.locator('#chatExport').isVisible());
   await p.locator('#chatLog .quick button').first().click();await p.waitForSelector('.calc .tot');
   const deposit=await p.locator('.calc .tot').innerText();assert.match(deposit,/RM200[\s\S]*RM1,400/,'published deposit and balance in '+lang);assert.ok(!deposit.includes('RM800'));
   await p.fill('#chatInput','Short question');await p.press('#chatInput','Enter');await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);
   // Exercise the synchronous direct link independently of transcript size.
   await p.locator('#chatLog .msg').evaluateAll(els=>els.forEach(el=>el.textContent='Short'));
   const count=(await p.evaluate(()=>window.__opened)).length;await p.click('#handoff');assert.equal((await p.evaluate(()=>window.__opened)).length,count+1);
   assert.ok(!await p.locator('#chatExport').isVisible());
console.log('PASS',lang,mode,'AI/fallback, CSP, escaping, responsive, direct full-conversation handover');await p.close();
  }
 }
}finally{await b.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
