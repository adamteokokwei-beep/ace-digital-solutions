/* Cost comparison only. No storage, network requests or visitor-data transmission. */
(function () {
  'use strict';
  function calculate(x) {
    const keys=['basket','orders','platformRate','subscription','setup','months','gatewayFlat','gatewayRate','feeTax','delivery','handling','otherFixed','platformFixed'];
    if(keys.some(k=>!Number.isFinite(x[k])||x[k]<0)||x.basket<=0||x.months<1||!Number.isSafeInteger(x.orders)||!Number.isSafeInteger(x.months)||['platformRate','gatewayRate','feeTax'].some(k=>x[k]>100)) return null;
    const payment=(x.gatewayFlat+x.basket*x.gatewayRate/100)*(1+x.feeTax/100);
    const directVariable=payment+x.delivery+x.handling, platformVariable=x.basket*x.platformRate/100;
    const directFixed=x.subscription+x.otherFixed+x.setup/x.months;
    const platformTotal=x.platformFixed+x.orders*platformVariable, directTotal=directFixed+x.orders*directVariable;
    if([payment,directVariable,platformVariable,directFixed,platformTotal,directTotal].some(n=>!Number.isFinite(n)))return null;
    const perOrderDifference=platformVariable-directVariable, fixedDifference=directFixed-x.platformFixed;
    let kind, threshold=null;
    if(perOrderDifference>1e-9){kind=fixedDifference>0?'threshold':'directLower';threshold=fixedDifference>0?Math.ceil(fixedDifference/perOrderDifference-1e-10):0;}
    else if(Math.abs(perOrderDifference)<=1e-9)kind=fixedDifference>1e-9?'platformLower':fixedDifference< -1e-9?'directFixedLower':'equal';
    else kind=fixedDifference>=0?'platformLower':'mixed';
    return {payment,directVariable,platformVariable,directFixed,platformTotal,directTotal,difference:platformTotal-directTotal,kind,threshold};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={calculate};
  if(typeof document==='undefined')return;
  const root=document.getElementById('ordering-cost-calculator');if(!root)return;
  const messages={
    en:{invalid:'Check your numbers: order amount above 0, at least 1 month, and percentages from 0 to 100.',threshold:'With these numbers, the website starts costing less at about {n} similar orders a month.',directLower:'With these numbers, the website has no higher monthly cost and costs less per order. This does not promise more customers.',platformLower:'With these numbers, more orders will not make the website option cheaper.',directFixedLower:'Both cost the same per order, but the website has lower monthly fees.',equal:'With these numbers, both options cost the same, however many orders you have.',mixed:'The website has lower monthly fees but costs more per order. It may be cheaper for fewer orders, not more.'},
    bm:{invalid:'Semak angka. Bakul mesti melebihi sifar; tempoh sekurang-kurangnya 1 bulan; kadar antara 0 dan 100%.',threshold:'Dengan angka ini, website mula lebih murah pada kira-kira {n} pesanan yang sama sebulan.',directLower:'Dengan angka ini, kos bulanan website tidak lebih tinggi dan setiap pesanan lebih murah. Ini bukan janji lebih ramai pelanggan.',platformLower:'Dengan angka ini, lebih banyak pesanan tidak akan menjadikan website lebih murah.',directFixedLower:'Kos setiap pesanan sama, tetapi yuran bulanan website lebih rendah.',equal:'Dengan angka ini, kos kedua-dua pilihan sama walau berapa pesanan pun.',mixed:'Yuran bulanan website lebih rendah, tetapi setiap pesanan lebih mahal. Ia mungkin lebih murah untuk pesanan sedikit, bukan lebih banyak.'},
    zh:{invalid:'请检查数字：餐点金额须大于零，比较期至少 1 个月，费率介于 0–100%。',threshold:'用这些数字来算，每月大约 {n} 张相同订单，网站就开始比较划算。',directLower:'用这些数字来算，网站月费不更高，每单费用也更低。但这不保证更多顾客。',platformLower:'用这些数字来算，订单再多也不会让网站方式更便宜。',directFixedLower:'两种方式每单费用相同，但网站月费较低。',equal:'用这些数字来算，不管多少订单，两种方式费用都一样。',mixed:'网站月费较低，但每单费用较高，可能只适合订单较少时使用；单多不一定省。'}
  };
  const lang=root.dataset.lang, words=messages[lang]||messages.en;
  const money=n=>'RM'+n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});
  function update(){
    const inputs=[...root.querySelectorAll('input')], message=root.querySelector('[data-result="message"]');
    const data=Object.fromEntries(inputs.map(e=>[e.name,e.value.trim()===''?NaN:Number(e.value)]));
    const result=inputs.every(e=>e.validity.valid)?calculate(data):null;
    if(!result){message.textContent=words.invalid;for(const e of root.querySelectorAll('[data-money]'))e.textContent='—';return;}
    for(const key of ['payment','directVariable','directFixed','platformTotal','directTotal','difference'])root.querySelector('[data-result="'+key+'"]').textContent=money(result[key]);
    message.textContent=words[result.kind].replace('{n}',String(result.threshold));
  }
  root.hidden=false;root.addEventListener('submit',e=>e.preventDefault());root.addEventListener('input',update);update();
})();
