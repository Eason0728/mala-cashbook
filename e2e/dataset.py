# -*- coding: utf-8 -*-
"""每次執行全新隨機資料，以及「照規格自己算一次」的預期值。

兩條規矩（Eason 2026-09-03 定的）：
1. 資料全部重抽——店名、月份、通行碼、科目清單、既有筆數、每一筆的金額與發票別都隨機。
   用開發時那組熟悉資料，只證明得了「系統對那組資料能動」。
2. 預期值由本檔照規格自己算，**絕不 import js/calc.js 的邏輯**——那是循環論證。

分層隨機：金額先抽一個「水準中心」（小額零用／中額進貨／大額月結），數字在中心附近浮動。
純均勻亂數會讓每筆都擠在中間值，稅額進位邊界、千分位、負淨額等分支就測不到。
"""
import random

STORES = ['新竹光復', '台中美村', '員林南昌', '中央廚房', '示範門市']

EXPENSE_POOL = ['食材', '蔬果', '瓦斯', '備品耗材', '清潔用品', '修繕維護',
                '水電', '房租管理費', '運費', '文具印刷', '員工餐費', '雜支']
INCOME_POOL = ['回收收入', '員工／同業購買', '代收轉付', '其他收入', '保險理賠']

VENDORS = ['安泰行', '福記食品', '大同瓦斯', '永豐蔬果', '中興五金', '光陽清潔',
           '新和工程', '台電代收', '順發文具', '協力運輸', '欣欣冷凍', '長江食材']
SUFFIX = ['冷藏', '常溫', '1桶', '管理費', '外裝維修', '當日青菜', '耗材補貨', '月結']

# 三種金額水準：(下限, 上限, 抽中的權重)
AMOUNT_TIERS = [(50, 400, 4), (400, 2500, 4), (2500, 12000, 2)]


def _tier_amount(rnd):
    tiers, weights = zip(*[((lo, hi), w) for lo, hi, w in AMOUNT_TIERS])
    lo, hi = rnd.choices(tiers, weights=weights, k=1)[0]
    return rnd.randint(lo, hi)


def make_dataset(seed=None):
    """產生一整套隨機資料。回傳的 dict 會被 run.py 注入成 window.__E2E_DATA。"""
    seed = seed if seed is not None else random.randrange(1, 10 ** 9)
    rnd = random.Random(seed)

    year = rnd.choice([2025, 2026])
    month_num = rnd.randint(1, 12)
    month = '%04d-%02d' % (year, month_num)
    store = rnd.choice(STORES)
    passcode = '%04d' % rnd.randrange(0, 10000)

    # 科目清單也隨機——寫死的話「科目存試算表可自由增減」這件事就沒被驗到
    expense_subjects = rnd.sample(EXPENSE_POOL, rnd.randint(6, len(EXPENSE_POOL)))
    income_subjects = rnd.sample(INCOME_POOL, rnd.randint(3, len(INCOME_POOL)))

    n_expense = rnd.randint(9, 18)
    n_income = rnd.randint(2, 5)
    rows = []
    seq = {'支出': 0, '收入': 0}

    def add(kind, subjects, idx):
        day = rnd.randint(1, 28)
        amount = _tier_amount(rnd)
        has_invoice = rnd.random() < 0.45          # 讓有票／無票兩條稅額路徑都出現
        subject = rnd.choice(subjects)
        name = '%s—%s' % (rnd.choice(VENDORS), rnd.choice(SUFFIX))
        seq[kind] += 1
        net, tax = split_tax(amount, has_invoice)
        rows.append({
            'id': '%s-%03d' % (month, idx + 1),
            'store': store,
            'date': '%s-%02d' % (month, day),
            'kind': kind,
            'subject': subject,
            'name': name,
            'amount': amount,
            'hasInvoice': has_invoice,
            'net': net,
            'tax': tax,
            'seq': seq[kind],
            'photo': '',
            'author': '店長',
            'createdAt': '%s-%02dT%02d:%02d:00+08:00' % (month, day, rnd.randint(8, 22), rnd.randint(0, 59)),
            'status': '正常',
        })

    idx = 0
    for _ in range(n_expense):
        add('支出', expense_subjects, idx); idx += 1
    for _ in range(n_income):
        add('收入', income_subjects, idx); idx += 1
    rnd.shuffle(rows)

    # 測試過程要新增的幾筆：刻意包含「用過的名稱」與「全新名稱」兩種，
    # 才驗得到「名稱→科目自動帶入」與「新項目提示沒有歷史紀錄」兩條分支
    known = rnd.choice([r for r in rows if r['kind'] == '支出'])
    to_add = [
        {'kind': '支出', 'subject': known['subject'], 'name': known['name'],
         'amount': _tier_amount(rnd), 'hasInvoice': True, 'known': True},
        {'kind': '支出', 'subject': rnd.choice(expense_subjects),
         'name': '全新廠商%03d—首次進貨' % rnd.randint(1, 999),
         'amount': _tier_amount(rnd), 'hasInvoice': False, 'known': False},
        {'kind': '收入', 'subject': rnd.choice(income_subjects),
         'name': '臨時收入%03d' % rnd.randint(1, 999),
         'amount': _tier_amount(rnd), 'hasInvoice': rnd.random() < 0.5, 'known': False},
    ]

    return {
        'seed': seed,
        'store': store,
        'month': month,
        'passcode': passcode,
        'expenseSubjects': expense_subjects,
        'incomeSubjects': income_subjects,
        'rows': rows,
        'lockedMonths': [],
        'toAdd': to_add,
    }


# ---------- 照規格自己算一次（不 import 系統的計算模組） ----------

def split_tax(amount, has_invoice):
    """規格：有發票 net=round(金額/1.05)、tax=金額−net；無發票 net=金額、tax=0。

    刻意不用 Python 的 round()——它是銀行家捨入（round(0.5)=0），
    JS 的 Math.round 是「.5 進位」。952.38 這種值兩者一致，但 .5 邊界會分岔。
    """
    amt = int(amount)
    if not has_invoice:
        return amt, 0
    net = int((amt / 1.05) + 0.5)
    return net, amt - net


def summarize(rows):
    expense = sum(r['amount'] for r in rows if r.get('status') != '作廢' and r['kind'] != '收入')
    income = sum(r['amount'] for r in rows if r.get('status') != '作廢' and r['kind'] == '收入')
    return {'expense': expense, 'income': income, 'net': income - expense,
            'count': len([r for r in rows if r.get('status') != '作廢'])}


def next_seq(rows, kind):
    """每月每收支別各自從 1 起算；作廢的仍占用編號不回收。"""
    return max([r['seq'] for r in rows if r['kind'] == kind] + [0]) + 1


def money(n):
    """畫面顯示格式：負數在錢號前面，千分位。JS 沒有 26.0 這種東西，一律整數。"""
    return ('-' if n < 0 else '') + '$' + format(abs(int(round(n))), ',')


def expectations(data):
    """一次算好整套預期值，run.py 只負責比對。"""
    rows = data['rows']
    s = summarize(rows)
    return {
        'count': len(rows),
        'expense': s['expense'],
        'income': s['income'],
        'net': s['net'],
        'expense_text': money(s['expense']),
        'income_text': money(s['income']),
        'net_text': money(s['net']),
        'next_expense_seq': next_seq(rows, '支出'),
        'next_income_seq': next_seq(rows, '收入'),
    }
