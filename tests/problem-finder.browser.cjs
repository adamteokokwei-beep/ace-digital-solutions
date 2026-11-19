// Chatbot problem finder: the guided questions reach a summary and a WhatsApp handover in EN (taps) and ZH (typed trigger + typed answers).
const {chromium}=require('playwright'),http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../site');
const server=http.createServer((q,s)=>{let p=q.url.split('?')[0];if(p.endsWith('/'))p+='index.html';const f=path.join(root,p);if(!fs.existsSync(f)){s.writeHead(404);return s.end();}s.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});s.end(fs.readFileSync(f));}).listen(8931);
(async()=>{const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});try{
  const page=async url=>{const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.route(/^https?:\/\/(?!localhost)/,r=>r.abort());await p.goto('http://localhost:8931'+url);await p.click('#chatFab');return [p,errors];};
  const tap=async(p,t)=>{await p.locator('#chatLog .quick button',{hasText:t}).last().click();};
  const type=async(p,t)=>{await p.waitForFunction(()=>!document.querySelector('#chatInput').disabled);await p.fill('#chatInput',t);await p.press('#chatInput','Enter');};
  let [p,errors]=await page('/');
  for(const t of ['Find my business problem','Office, accounting or admin','Accounting and invoices','Keying in receipts and invoices','Every day','More than 10 hours']) await tap(p,t);
  await type(p,'Excel and SQL Accounting'); await tap(p,'Fewer mistakes');
  await p.locator('#chatLog .quick button',{hasText:'Send to Adam on WhatsApp'}).waitFor();
  let log=await p.locator('#chatLog').innerText();
  for(const s of ['Keying in receipts and invoices','More than 10 hours','Excel and SQL Accounting','Accounting Automation','RM1,888–RM5,888']) assert.ok(log.includes(s),s);
  assert.deepEqual(errors,[]); await p.close(); console.log('PASS problem finder EN taps');
  [p,errors]=await page('/zh/');
  await type(p,'我们每天手动输入发票，经常出错');
  await p.locator('#chatLog .quick button',{hasText:'咖啡馆或餐厅'}).waitFor();
  await type(p,'建材批发'); await tap(p,'其他问题'); await type(p,'仓库和门市的库存对不上');
  await tap(p,'每周几次'); await tap(p,'2–5 小时'); await tap(p,'跳过'); await tap(p,'节省时间');
  await p.locator('#chatLog .quick button',{hasText:'发送到 Adam 的 WhatsApp'}).waitFor();
  log=await p.locator('#chatLog').innerText();
  for(const s of ['我的理解如下','建材批发','仓库和门市的库存对不上','每周几次']) assert.ok(log.includes(s),s);
  assert.deepEqual(errors,[]); await p.close(); console.log('PASS problem finder ZH typed answers');
}finally{await b.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
