# -*- coding: utf-8 -*-
"""給操作圖解用的示範資料：新竹光復店、貼近真實的廠商與金額（數字仍是編的）。"""
import json

rows_raw = [
    (2, '支出', '食材', '吉順行—冷藏', 2450, False),
    (2, '支出', '瓦斯', '萬源瓦斯—1桶', 650, False),
    (3, '支出', '蔬果', '永豐蔬果—當日青菜', 880, False),
    (3, '支出', '房租管理費', '昌益大樓—管理費', 450, False),
    (4, '支出', '備品耗材', '光陽清潔—耗材補貨', 320, True),
    (5, '支出', '食材', '吉順行—常溫', 1780, False),
    (5, '收入', '回收收入', '廚餘—酸桶回收', 1000, False),
]
seq = {'支出': 0, '收入': 0}
rows = []
for i, (d, kind, subj, name, amt, inv) in enumerate(rows_raw):
    seq[kind] += 1
    net = int(amt / 1.05 + 0.5) if inv else amt
    rows.append({
        'id': '2026-09-%03d' % (i + 1), 'store': '新竹光復',
        'date': '2026-09-%02d' % d, 'kind': kind, 'subject': subj, 'name': name,
        'amount': amt, 'hasInvoice': inv, 'net': net, 'tax': amt - net if inv else 0,
        'seq': seq[kind], 'photo': '', 'author': '店長',
        'createdAt': '2026-09-%02dT10:%02d:00+08:00' % (d, i * 7), 'status': '正常',
    })
print(json.dumps({
    'store': '新竹光復', 'month': '2026-09', 'passcode': '1234',
    'expenseSubjects': ['食材', '蔬果', '瓦斯', '備品耗材', '清潔用品', '修繕維護',
                        '水電', '房租管理費', '運費', '文具印刷', '員工餐費', '雜支'],
    'incomeSubjects': ['回收收入', '員工／同業購買', '代收轉付', '其他收入'],
    'rows': rows, 'lockedMonths': [],
}, ensure_ascii=False))
