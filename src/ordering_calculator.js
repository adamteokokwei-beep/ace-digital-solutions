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
    en:{invalid:'Check the figures. Basket value must be above zero; months at least 1; rates between 0 and 100%.',threshold:'Cost crossover: {n} comparable orders/month under these assumptions.',directLower:'Direct ordering has no higher fixed cost and a lower variable cost here. Demand is not predicted.',platformLower:'No threshold where greater volume makes direct ordering cheaper under these assumptions.',directFixedLower:'Variable costs are equal; direct fixed costs are lower. There is no volume-based crossover.',equal:'The two cost estimates are equal at every order volume under these assumptions.',mixed:'Direct ordering has lower fixed costs but higher cost per order. It may cost less at low volume; more orders do not guarantee savings.'},
    bm:{invalid:'Semak angka. Bakul mesti melebihi sifar; tempoh sekurang-kurangnya 1 bulan; kadar antara 0 dan 100%.',threshold:'Titik persilangan kos: {n} pesanan setara/bulan mengikut andaian ini.',directLower:'Kos tetap langsung tidak lebih tinggi dan kos berubah lebih rendah di sini. Permintaan tidak diramal.',platformLower:'Tiada ambang apabila jumlah lebih tinggi menjadikan pesanan langsung lebih murah mengikut andaian ini.',directFixedLower:'Kos berubah sama; kos tetap langsung lebih rendah. Tiada titik persilangan berdasarkan jumlah.',equal:'Kedua-dua anggaran kos sama pada semua jumlah pesanan mengikut andaian ini.',mixed:'Kos tetap langsung lebih rendah tetapi kos setiap pesanan lebih tinggi. Ia mungkin lebih murah pada jumlah rendah; lebih banyak pesanan bukan jaminan penjimatan.'},
    zh:{invalid:'请检查数字：餐点金额须大于零，比较期至少 1 个月，费率介于 0–100%。',threshold:'按这些假设，成本分界点为每月 {n} 张同等订单。',directLower:'这里自家渠道固定成本不更高，每单变动成本更低；此结果不预测顾客需求。',platformLower:'按这些假设，不存在订单越多就让自家渠道更便宜的门槛。',directFixedLower:'每单变动成本相同，自家渠道固定成本较低，没有按订单量变化的分界点。',equal:'按这些假设，两种渠道在所有订单量的估计成本都相同。',mixed:'自家渠道固定成本较低，但每单成本更高，可能只在低订单量时较便宜；订单增加不保证省钱。'}
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
