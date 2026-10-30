"""Local-only calculator markup for the restaurant cost guide."""
import html

FIELDS=[('basket',50,0.01,None),('orders',100,0,None),('platformRate',20,0,100),('subscription',168,0,None),('setup',1688,0,None),('months',24,1,120),('gatewayFlat',1.25,0,None),('gatewayRate',0,0,100),('feeTax',8,0,100),('delivery',3,0,None),('handling',1.5,0,None),('otherFixed',0,0,None),('platformFixed',0,0,None)]
LABELS={
'en':['Average order amount (RM)','Orders to compare each month','App charges you pay, including tax (%)','Website monthly fee (RM)','Setup cost (RM)','Spread setup over how many months?','Fixed payment fee per order (RM)','Payment fee by percentage (%)','Tax on the payment fee (%)','Delivery cost you pay per order (RM)','Extra staff and marketing cost per order (RM)','Other website costs per month (RM)','App monthly fee, if any (RM)'],
'bm':['Purata jumlah pesanan (RM)','Jumlah pesanan untuk dibandingkan sebulan','Caj aplikasi yang anda bayar, termasuk cukai (%)','Langganan laman (RM/bulan)','Kos persediaan (RM)','Tempoh perbandingan (bulan)','Caj pembayaran tetap setiap pesanan (RM)','Caj pembayaran mengikut peratus (%)','Cukai atas caj pembayaran (%)','Kos delivery yang anda bayar setiap pesanan (RM)','Kos staf dan pemasaran tambahan setiap pesanan (RM)','Kos website lain sebulan (RM)','Yuran bulanan aplikasi, jika ada (RM)'],
'zh':['平均每单金额（RM）','每月用来比较的订单数','您付的平台费用，含税（%）','网站订阅（RM/月）','建置费（RM）','建置费分几个月来比较？','每单固定支付费（RM）','支付费百分比（%）','支付手续费的税率（%）','您自己付的配送费（RM/单）','额外员工与推广费用（RM/单）','网站其他月费（RM）','平台固定费（RM/月）']}
WORDS={
'en':['Which costs less?','Change the other costs','Cost','Amount','Payment fee per order','Website cost for each order','Website monthly costs, with a share of setup','App cost per month','Website cost per month, with a share of setup','How much less the website costs per month','A positive number means the website costs less. A negative number means it costs more. These are estimates, not your profit or a promise of orders. Your numbers are not sent or saved.','JavaScript is needed for the interactive calculator. The worked example, formulas and assumptions remain available above and below.'],
'bm':['Yang mana lebih murah?','Ubah kos lain','Ukuran','Anggaran anda','Caj pembayaran setiap pesanan','Kos setiap pesanan website','Kos website sebulan, termasuk bahagian persediaan','Kos platform/bulan','Jumlah kos website sebulan, termasuk bahagian persediaan','Berapa kurang kos website sebulan','Beza positif bermakna anggaran kos langsung lebih rendah; negatif lebih tinggi. Ilustrasi sahaja, bukan ramalan untung atau permintaan. Input kekal di halaman ini dan tidak disimpan.','JavaScript diperlukan untuk kalkulator interaktif. Contoh, formula dan andaian masih tersedia di atas dan bawah.'],
'zh':['哪一种比较省？','修改其他费用','项目','您的估计','每单支付手续费','网站每单要付的费用','网站每月固定费，含一部分建置费','每月平台成本','网站每月总费用，含一部分建置费','网站每月少花多少钱','差额为正，表示自家渠道估计成本较低；为负则较高。这是成本示例，并非利润或需求预测。输入仅在本页使用，不会保存。','互动计算器需要 JavaScript。上方示例与下方公式、假设仍可直接阅读。']}

def markup(lang):
    w=WORDS[lang]
    def field(i):
        name,value,minimum,maximum=FIELDS[i]
        maxattr='' if maximum is None else f' max="{maximum}"'
        step='1' if name in ('orders','months') else 'any'
        return f'<label for="oc-{name}">{html.escape(LABELS[lang][i])}<input id="oc-{name}" name="{name}" type="number" inputmode="decimal" min="{minimum}"{maxattr} step="{step}" value="{value}" required></label>'
    rows=''.join(f'<tr><th scope="row">{html.escape(w[i+4])}</th><td data-money data-result="{key}">—</td></tr>' for i,key in enumerate(['payment','directVariable','directFixed','platformTotal','directTotal','difference']))
    return f'''<form id="ordering-cost-calculator" class="ordering-calculator" data-lang="{lang}" aria-label="{html.escape(w[0],quote=True)}" hidden><fieldset><legend>{w[0]}</legend><div class="oc-fields">{''.join(field(i) for i in range(4))}</div></fieldset><details><summary>{w[1]}</summary><div class="oc-fields">{''.join(field(i) for i in range(4,len(FIELDS)))}</div></details><p class="oc-message" data-result="message" role="status" aria-live="polite"></p><div class="a-table"><table><thead><tr><th scope="col">{w[2]}</th><th scope="col">{w[3]}</th></tr></thead><tbody>{rows}</tbody></table></div><p class="oc-note">{w[10]}</p></form><noscript><p>{w[11]}</p></noscript>'''
