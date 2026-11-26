// US restaurant demo: order with options -> correct USD totals -> kitchen ticket -> customer status, under the real CSP.
// Also checks the demo card appears in My Work on /us/ only.
const {chromium}=require('playwright'),http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../site');
const policy=fs.readFileSync(path.join(root,'_headers'),'utf8').match(/Content-Security-Policy: (.+)/)[1].replace('upgrade-insecure-requests','');
const server=http.createServer((q,s)=>{let p=q.url.split('?')[0];if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);if(!fs.existsSync(f)){s.writeHead(404);return s.end();}const html=p.endsWith('.html');s.writeHead(200,{'Content-Type':html?'text/html':'application/octet-stream',...(html?{'Content-Security-Policy':policy}:{})});s.end(fs.readFileSync(f));}).listen(8932);
(async()=>{const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});try{
  for(const width of [1200,390]){
    const p=await b.newPage({viewport:{width,height:900}});const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(/Content Security Policy/i.test(m.text()))errors.push(m.text());});
    await p.goto('http://localhost:8932/demos/austin-restaurant/');
    await p.click('[data-add="m3"]'); await p.check('#dOpts input[name="g0"][value="2"]'); await p.check('#dOpts input[name="g1"][value="0"]'); await p.check('#dOpts input[name="g2"][value="1"]');
    await p.click('#qPlus'); assert.equal(await p.textContent('#dAdd'),'Add $34.00'); await p.click('#dAdd');
    await p.click('[data-add="d1"]'); await p.click('#dAdd'); await p.click('[data-tip="0.2"]');
    assert.equal(await p.textContent('#sTotal'),'$48.09');                       // 37.50 + 3.09 tax (8.25%) + 7.50 tip
    await p.click('[data-mode="delivery"]'); assert.equal(await p.textContent('#sTotal'),'$53.08'); // + $4.99 delivery
    await p.fill('#cname','Jordan'); await p.fill('#cphone','(512) 555-0142'); await p.click('#pay');
    assert.ok(await p.isVisible('#cerr'),'delivery needs an address'); await p.fill('#addr','1200 Demo St'); await p.click('#pay');
    const ticket=await p.locator('#kNew .ticket').innerText(); for(const s of ['Jordan','DELIVERY','Spice level: Hot','No onion','Add avocado']) assert.ok(ticket.includes(s),s);
    await p.click('#kNew [data-adv]'); await p.click('#kCook [data-adv]');
    assert.ok((await p.textContent('#status')).includes('DoorDash driver'));
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]); await p.close(); console.log('PASS restaurant demo order flow',width);
  }
  for(const [url,expect] of [['/us/',true],['/',false]]){const p=await b.newPage();await p.route(/^https?:\/\/(?!localhost)/,r=>r.abort());await p.goto('http://localhost:8932'+url);
    assert.equal(await p.locator('#workGrid a[href="/demos/austin-restaurant/"]').count(),expect?1:0,url);await p.close();}
  console.log('PASS demo card on /us/ only');
}finally{await b.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
