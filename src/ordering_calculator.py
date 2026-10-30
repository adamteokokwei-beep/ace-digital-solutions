"""Local-only calculator markup for the restaurant cost guide."""
import html

FIELDS=[('basket',50,0.01,None),('orders',100,0,None),('platformRate',20,0,100),('subscription',168,0,None),('setup',1688,0,None),('months',24,1,120),('gatewayFlat',1.25,0,None),('gatewayRate',0,0,100),('feeTax',8,0,100),('delivery',3,0,None),('handling',1.5,0,None),('otherFixed',0,0,None),('platformFixed',0,0,None)]
LABELS={
'en':['Basket value (RM)','Comparable orders per month','Effective platform charge, including fee tax (%)','Website subscription (RM/month)','Setup cost (RM)','Comparison period (months)','Fixed gateway fee (RM/order)','Percentage gateway fee (%)','Tax on gateway fee (%)','Restaurant-paid net delivery (RM/order)','Extra handling and acquisition (RM/order)','Other direct fixed costs (RM/month)','Platform fixed costs (RM/month)'],
'bm':['Nilai bakul (RM)','Pesanan setara sebulan','Caj efektif platform termasuk cukai caj (%)','Langganan laman (RM/bulan)','Kos persediaan (RM)','Tempoh perbandingan (bulan)','Caj tetap gerbang (RM/pesanan)','Caj peratusan gerbang (%)','Cukai atas caj gerbang (%)','Penghantaran bersih restoran (RM/pesanan)','Pengendalian dan pemerolehan tambahan (RM/pesanan)','Kos tetap langsung lain (RM/bulan)','Kos tetap platform (RM/bulan)'],
'zh':['餐点金额（RM）','每月同等订单数','平台实际费率，含手续费税（%）','网站订阅（RM/月）','建置费（RM）','比较期（月）','网关固定费（RM/单）','网关百分比费率（%）','网关手续费税率（%）','餐厅承担的配送净额（RM/单）','额外处理与获客（RM/单）','其他自家渠道固定费（RM/月）','平台固定费（RM/月）']}
WORDS={
'en':['Cost comparison calculator','Edit payment, delivery and setup assumptions','Measure','Your estimate','Payment fee per order','Direct variable cost per order','Direct fixed costs/month, including spread setup','Platform cost/month','Direct cost/month, including spread setup','Platform cost minus direct cost/month','Positive difference means lower estimated direct costs; negative means higher. Figures are illustrative, not profit or demand forecasts. Your inputs stay in this page and are not saved.','JavaScript is needed for the interactive calculator. The worked example, formulas and assumptions remain available above and below.'],
'bm':['Kalkulator perbandingan kos','Ubah andaian pembayaran, penghantaran dan persediaan','Ukuran','Anggaran anda','Caj pembayaran setiap pesanan','Kos berubah langsung setiap pesanan','Kos tetap langsung/bulan termasuk agihan persediaan','Kos platform/bulan','Kos langsung/bulan termasuk agihan persediaan','Kos platform tolak kos langsung/bulan','Beza positif bermakna anggaran kos langsung lebih rendah; negatif lebih tinggi. Ilustrasi sahaja, bukan ramalan untung atau permintaan. Input kekal di halaman ini dan tidak disimpan.','JavaScript diperlukan untuk kalkulator interaktif. Contoh, formula dan andaian masih tersedia di atas dan bawah.'],
'zh':['渠道成本比较计算器','调整支付、配送与建置费假设','项目','您的估计','每单支付手续费','每单自家渠道变动成本','每月自家固定成本，含分摊建置费','每月平台成本','每月自家渠道成本，含分摊建置费','每月平台成本减去自家渠道成本','差额为正，表示自家渠道估计成本较低；为负则较高。这是成本示例，并非利润或需求预测。输入仅在本页使用，不会保存。','互动计算器需要 JavaScript。上方示例与下方公式、假设仍可直接阅读。']}

def markup(lang):
    w=WORDS[lang]
    def field(i):
        name,value,minimum,maximum=FIELDS[i]
        maxattr='' if maximum is None else f' max="{maximum}"'
        step='1' if name in ('orders','months') else 'any'
        return f'<label for="oc-{name}">{html.escape(LABELS[lang][i])}<input id="oc-{name}" name="{name}" type="number" inputmode="decimal" min="{minimum}"{maxattr} step="{step}" value="{value}" required></label>'
    rows=''.join(f'<tr><th scope="row">{html.escape(w[i+4])}</th><td data-money data-result="{key}">—</td></tr>' for i,key in enumerate(['payment','directVariable','directFixed','platformTotal','directTotal','difference']))
    return f'''<form id="ordering-cost-calculator" class="ordering-calculator" data-lang="{lang}" aria-label="{html.escape(w[0],quote=True)}" hidden><fieldset><legend>{w[0]}</legend><div class="oc-fields">{''.join(field(i) for i in range(4))}</div></fieldset><details><summary>{w[1]}</summary><div class="oc-fields">{''.join(field(i) for i in range(4,len(FIELDS)))}</div></details><p class="oc-message" data-result="message" role="status" aria-live="polite"></p><div class="a-table"><table><thead><tr><th scope="col">{w[2]}</th><th scope="col">{w[3]}</th></tr></thead><tbody>{rows}</tbody></table></div><p class="oc-note">{w[10]}</p></form><noscript><p>{w[11]}</p></noscript>'''
