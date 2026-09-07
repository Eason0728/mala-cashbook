#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""現金收支登記 端到端測試：每次全新隨機資料，驗算稅額與合計，稽核每一顆按鈕。

  python3 e2e/run.py
  E2E_SEED=12345 python3 e2e/run.py     # 重現某次的資料

一律跑 ?mode=local（本機 mock），不碰真試算表。
種子資料由本測試注入 window.__E2E_DATA，不使用 js/demo-data.js 的示範值。

假日期：系統的日期欄預設「今天」，而測試資料的月份是隨機抽的。
用 add_init_script 把 window.Date 挪到資料月份的某一天，
預設日期才對得上，「月結鎖定擋新增」也才驗得到。
"""
import json
import os
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import make_dataset, expectations, split_tax, summarize, next_seq, money  # noqa: E402
from clickmap import ClickMap, KEY_JS                                                  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'e2e', 'artifacts')
PORT = int(os.environ.get('E2E_PORT', '8931'))
BASE = 'http://localhost:%d' % PORT

RESULTS = []
CM = ClickMap()


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok), str(detail)))
    print(('✅ ' if ok else '❌ ') + name + (('　' + str(detail)) if (detail and not ok) else ''))


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)


def click(page, selector, verified):
    k = page.evaluate(KEY_JS, selector)
    try:
        page.click(selector, timeout=3000)
    except Exception:
        page.evaluate("(s) => { const e = document.querySelector(s); if (e) e.click(); }", selector)
    if k:
        CM.mark(k, verified)


def text(page, sel):
    return page.evaluate("(s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : ''; }", sel)


def val(page, sel):
    return page.evaluate("(s) => { const e = document.querySelector(s); return e ? e.value : ''; }", sel)


def rows_state(page):
    return page.evaluate("() => window.App.State.rows.map(r => ({...r}))")


def wait_idle(page, sel='#btn-submit', timeout=15000):
    """等 Busy.run 跑完——按鈕文字回到原樣、可以再按為止。"""
    page.wait_for_function(
        "(s) => { const b = document.querySelector(s);"
        "        return b && !b.disabled && b.textContent.indexOf('送出中') < 0"
        "               && b.textContent.indexOf('已記錄') < 0; }",
        arg=sel, timeout=timeout)


def main():
    seed = os.environ.get('E2E_SEED')
    data = make_dataset(int(seed) if seed else None)
    exp = expectations(data)
    print('=' * 72)
    print('隨機種子 E2E_SEED=%d　店別 %s　月份 %s　通行碼 %s'
          % (data['seed'], data['store'], data['month'], data['passcode']))
    print('既有 %d 筆（支出合計 %s／收入合計 %s）'
          % (exp['count'], exp['expense_text'], exp['income_text']))
    print('=' * 72)

    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--directory', ROOT],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={'width': 420, 'height': 900})

            # 注入隨機資料，並把「今天」挪進資料月份（日期欄預設今天，月份要對得上）
            fake_day = '%s-15' % data['month']
            ctx.add_init_script("""
              window.__E2E_DATA = %s;
              const FAKE = new Date('%sT10:30:00+08:00').getTime();
              const RealDate = Date;
              const offset = FAKE - RealDate.now();
              function FakeDate(...a) {
                if (a.length === 0) return new RealDate(RealDate.now() + offset);
                return new RealDate(...a);
              }
              FakeDate.prototype = RealDate.prototype;
              FakeDate.now = () => RealDate.now() + offset;
              FakeDate.parse = RealDate.parse;
              FakeDate.UTC = RealDate.UTC;
              window.Date = FakeDate;
            """ % (json.dumps(data, ensure_ascii=False), fake_day))

            page = ctx.new_page()
            page.goto(BASE + '/?mode=local', wait_until='networkidle')
            page.evaluate("() => { localStorage.clear(); }")
            page.reload(wait_until='networkidle')

            run_login(page, data)
            run_entry(page, data, exp)
            run_list(page, data)
            run_export(page, data)
            run_lock(page, data)

            report(page)
            browser.close()
    finally:
        srv.terminate()

    failed = [r for r in RESULTS if not r[1]]
    print('\n' + '=' * 72)
    print('共 %d 項檢查，通過 %d，失敗 %d' % (len(RESULTS), len(RESULTS) - len(failed), len(failed)))
    if failed:
        print('\n失敗項目：')
        for n, _, d in failed:
            print('  ❌ %s　%s' % (n, d))
        print('\n重現這組資料：E2E_SEED=%d python3 e2e/run.py' % data['seed'])
    print('=' * 72)
    return 1 if failed else 0


# ---------- 各段流程 ----------

def run_login(page, data):
    CM.scan(page, '登入')
    check('本機測試模式橫幅有出現', page.evaluate("() => !document.getElementById('mode-banner').hidden"))

    page.fill('#passcode', '0' * 4 if data['passcode'] != '0000' else '1111')
    click(page, '#btn-login', '錯誤通行碼被擋下')
    page.wait_for_timeout(800)
    check('打錯通行碼進不去', page.evaluate("() => !document.getElementById('view-login').hidden"),
          '錯碼卻進去了')
    check('錯碼有顯示訊息', '通行碼' in text(page, '#login-error'), text(page, '#login-error'))

    page.fill('#passcode', data['passcode'])
    click(page, '#btn-login', '正確通行碼進入登記畫面')
    # 進不去就直接中止並印 FAIL——裁判要報告失敗，不是自己 crash 掉。
    # 2026-09-08：常用項目裡混了 Number 名稱時，登入會炸在 renderChips，
    # 當時測試是整支例外結束，看不出是哪一項壞了。
    try:
        page.wait_for_selector('#view-entry:not([hidden])', timeout=15000)
        entered = True
    except Exception as e:
        entered = False
        print('　　登入卡住了，畫面錯誤訊息：%s' % text(page, '#login-error'))
    check('正確通行碼可以進入', entered, text(page, '#login-error'))
    if not entered:
        raise SystemExit(report_and_exit())
    # 常用項目裡混了 Number 與 None 的名稱（試算表會這樣回），登入不能因此炸掉
    check('髒型別的常用項目不會擋住登入', text(page, '#login-error') == '',
          text(page, '#login-error'))
    shot(page, '01-登記畫面')


def run_entry(page, data, exp):
    CM.scan(page, '登記')

    # 三個數字
    summary = text(page, '#summary-entry')
    check('本月支出合計正確', exp['expense_text'] in summary, '畫面=%s 期望=%s' % (summary, exp['expense_text']))
    check('本月收入合計正確', exp['income_text'] in summary, '畫面=%s 期望=%s' % (summary, exp['income_text']))
    check('淨額正確', exp['net_text'] in summary, '畫面=%s 期望=%s' % (summary, exp['net_text']))

    # 科目下拉＝注入的科目清單（證明科目沒寫死在程式裡）
    opts = page.evaluate("() => [...document.querySelectorAll('#f-subject option')].map(o => o.value)")
    check('支出科目下拉＝注入的清單', opts == data['expenseSubjects'],
          '畫面=%s 期望=%s' % (opts, data['expenseSubjects']))

    # 日期預設今天（假日期已挪進資料月份）
    check('日期預設今天', val(page, '#f-date') == '%s-15' % data['month'], val(page, '#f-date'))

    # 稅額即時預覽：兩條分支各驗一次
    page.fill('#f-amount', '1000')
    click(page, '#invoice-toggle [data-inv="1"]', '切成統一發票')
    page.wait_for_timeout(150)
    net, tax = split_tax(1000, True)
    tp = text(page, '#tax-preview').replace(',', '')
    check('有發票 1000 → 未稅 %d 稅 %d' % (net, tax), str(net) in tp and str(tax) in tp, tp)

    click(page, '#invoice-toggle [data-inv="0"]', '切成收據／無發票')
    page.wait_for_timeout(150)
    tp = text(page, '#tax-preview').replace(',', '')
    check('無發票 1000 → 未稅 1000 稅 0', '1000' in tp and '0' in tp, tp)

    # 名稱記憶：舊名稱自動帶科目
    known = [a for a in data['toAdd'] if a['known']][0]
    page.fill('#f-name', known['name'])
    page.wait_for_timeout(250)
    check('打過的名稱自動帶出科目', val(page, '#f-subject') == known['subject'],
          '帶出=%s 期望=%s' % (val(page, '#f-subject'), known['subject']))
    check('自動帶入時提示是綠字', 'ok' in page.get_attribute('#subject-hint', 'class'),
          page.get_attribute('#subject-hint', 'class'))

    # 新名稱 → 沒有歷史紀錄
    page.fill('#f-name', '從沒用過的名字%d' % data['seed'])
    page.wait_for_timeout(250)
    check('新項目提示沒有歷史紀錄', '沒有歷史紀錄' in text(page, '#subject-hint'), text(page, '#subject-hint'))
    check('新項目提示是警示樣式', 'warn' in page.get_attribute('#subject-hint', 'class'))

    # 常用快選點一下帶入名稱＋科目
    # 先清空輸入框：上一步剛打完一個不存在的名稱，那時候選本來就會是空的
    page.fill('#f-name', '')
    page.wait_for_timeout(250)
    chips = page.evaluate("() => [...document.querySelectorAll('#name-chips .chip')].map(c => c.dataset.name)")
    check('常用快選有出現且不超過 8 個', 0 < len(chips) <= 8, '%d 個' % len(chips))
    # 數字名稱要被轉成字串照樣顯示得出來，不能整組候選消失
    numeric = [c for c in chips if c and c.isdigit()]
    check('數字型的項目名稱有被正規化成字串',
          page.evaluate("() => window.Memory.recent().every(f => typeof f.name === 'string')"),
          '仍有非字串的 name')
    if chips:
        click(page, '#name-chips .chip', '點快選帶入名稱與科目')
        page.wait_for_timeout(200)
        check('點快選帶入了名稱', val(page, '#f-name') == chips[0], val(page, '#f-name'))

    # 清空重填
    page.fill('#f-amount', '9999')
    before = len(rows_state(page))
    click(page, '#btn-clear', '清空重填')
    page.wait_for_timeout(200)
    check('清空後欄位淨空', val(page, '#f-name') == '' and val(page, '#f-amount') == '')
    check('清空不會動到已存的資料', len(rows_state(page)) == before)

    # 送出三筆（含收入，順便驗收支別切換換科目清單）
    for i, a in enumerate(data['toAdd']):
        if a['kind'] == '收入':
            click(page, '#kind-seg [data-kind="收入"]', '切到收入，科目清單換成收入科目')
            page.wait_for_timeout(200)
            iopts = page.evaluate("() => [...document.querySelectorAll('#f-subject option')].map(o => o.value)")
            check('收入科目下拉＝注入的清單', iopts == data['incomeSubjects'], iopts)
        expected_seq = next_seq(rows_state(page), a['kind'])
        page.fill('#f-name', a['name'])
        page.wait_for_timeout(200)
        page.select_option('#f-subject', a['subject'])
        CM.mark(page.evaluate(KEY_JS, '#f-subject'), '手動選科目')
        page.fill('#f-amount', str(a['amount']))
        if a['hasInvoice']:
            click(page, '#invoice-toggle [data-inv="1"]', '送出前選統一發票')
        else:
            click(page, '#invoice-toggle [data-inv="0"]', '送出前選收據')
        click(page, '#btn-submit', '送出一筆並寫入')
        wait_idle(page)

        last = rows_state(page)[-1]
        net, tax = split_tax(a['amount'], a['hasInvoice'])
        check('第%d筆 金額 %d 寫入正確' % (i + 1, a['amount']), last['amount'] == a['amount'], last['amount'])
        check('第%d筆 未稅 %d／稅額 %d 正確' % (i + 1, net, tax),
              last['net'] == net and last['tax'] == tax, '實得 %s/%s' % (last['net'], last['tax']))
        check('第%d筆 收據編號 %d 正確' % (i + 1, expected_seq), last['seq'] == expected_seq, last['seq'])
        check('第%d筆 送出後金額欄清空' % (i + 1), val(page, '#f-amount') == '')
        check('第%d筆 送出後日期留著' % (i + 1), val(page, '#f-date') != '')

    click(page, '#kind-seg [data-kind="支出"]', '切回支出')
    shot(page, '02-送出後')


def run_list(page, data):
    click(page, '#tabs [data-view="list"]', '切到本月清單')
    page.wait_for_selector('#view-list:not([hidden])')
    page.wait_for_timeout(300)
    CM.scan(page, '清單')

    rows = rows_state(page)
    shown = page.evaluate("() => document.querySelectorAll('#entry-list .entry').length")
    check('清單筆數與資料相符', shown == len(rows), '畫面 %d／資料 %d' % (shown, len(rows)))
    check('清單沒有刪除鍵（刪除一律留痕）',
          page.evaluate("() => !document.querySelector('#entry-list [data-act=\\'delete\\']')"))

    # 排序：日期新的在上
    dates = page.evaluate("() => [...document.querySelectorAll('#entry-list .entry .date')].map(e => e.textContent.trim())")
    check('清單依日期由新到舊', dates == sorted(dates, reverse=True), dates[:5])

    # 點列展開才有操作鍵
    check('收合時沒有操作鍵',
          page.evaluate("() => document.querySelectorAll('#entry-list [data-act]').length") == 0)
    page.click('#entry-list .entry >> nth=0')
    page.wait_for_timeout(250)
    acts = page.evaluate("() => [...document.querySelectorAll('#entry-list [data-act]')].map(b => b.dataset.act)")
    check('點列展開出現修改與作廢', sorted(set(acts)) == ['edit', 'void'], acts)
    CM.scan(page, '清單（展開）')

    # 修改一筆：改金額與發票別，驗重新拆稅
    target = page.evaluate("() => document.querySelector('#entry-list .entry.open').dataset.id")
    before = [r for r in rows_state(page) if r['id'] == target][0]
    new_amount = before['amount'] + 137
    new_invoice = not before['hasInvoice']
    click(page, '#entry-list [data-act="edit"]', '展開行內編輯表單')
    page.wait_for_timeout(250)
    CM.scan(page, '清單（編輯表單）')
    page.fill('#entry-list .entry.open [data-f="amount"]', str(new_amount))
    page.select_option('#entry-list .entry.open [data-f="hasInvoice"]', '1' if new_invoice else '0')
    CM.mark(page.evaluate(KEY_JS, '#entry-list .entry.open [data-f=\'hasInvoice\']'), '編輯表單改單據別')
    CM.mark(page.evaluate(KEY_JS, '#entry-list .entry.open [data-f=\'subject\']'), '編輯表單的科目下拉')
    click(page, '#entry-list [data-act="save"]', '儲存修改')
    page.wait_for_timeout(900)
    after = [r for r in rows_state(page) if r['id'] == target][0]
    net, tax = split_tax(new_amount, new_invoice)
    check('修改後金額正確', after['amount'] == new_amount, after['amount'])
    check('修改後重新拆稅正確（未稅 %d／稅 %d）' % (net, tax),
          after['net'] == net and after['tax'] == tax, '實得 %s/%s' % (after['net'], after['tax']))

    # 取消鍵
    page.click('#entry-list .entry >> nth=1')
    page.wait_for_timeout(200)
    click(page, '#entry-list [data-act="edit"]', '再次展開編輯')
    page.wait_for_timeout(250)
    click(page, '#entry-list [data-act="cancel"]', '取消編輯，不寫入')
    page.wait_for_timeout(250)
    check('取消編輯不會改到資料',
          [r for r in rows_state(page) if r['id'] == target][0]['amount'] == new_amount)

    # 作廢：合計要變、資料列要留著
    page.on('dialog', lambda d: d.accept('e2e 作廢原因'))
    page.click('#entry-list .entry >> nth=0')
    page.wait_for_timeout(250)
    voided_id = page.evaluate("() => document.querySelector('#entry-list .entry.open').dataset.id")
    v_before = [r for r in rows_state(page) if r['id'] == voided_id][0]
    n_before = len(rows_state(page))
    s_before = summarize(rows_state(page))
    click(page, '#entry-list [data-act="void"]', '作廢一筆')
    page.wait_for_timeout(1200)

    after_rows = rows_state(page)
    v_after = [r for r in after_rows if r['id'] == voided_id][0]
    s_after = summarize(after_rows)
    key = 'income' if v_before['kind'] == '收入' else 'expense'
    check('作廢後資料列沒有被刪掉', len(after_rows) == n_before, '%d → %d' % (n_before, len(after_rows)))
    check('作廢的那筆狀態＝作廢', v_after['status'] == '作廢', v_after['status'])
    check('作廢有記下時間', bool(v_after.get('voidedAt')))
    check('作廢有記下原因', bool(v_after.get('voidReason')), v_after.get('voidReason'))
    check('作廢後合計扣掉那筆金額（%d）' % v_before['amount'],
          s_after[key] == s_before[key] - v_before['amount'],
          '%d → %d' % (s_before[key], s_after[key]))
    check('作廢那列仍在畫面上',
          page.evaluate("(id) => !!document.querySelector('#entry-list .entry.voided[data-id=\\'' + id + '\\']')", voided_id))
    check('作廢後那列沒有操作鍵',
          page.evaluate("(id) => !document.querySelector('.entry[data-id=\\'' + id + '\\'] [data-act]')", voided_id))
    check('畫面合計與重算相符', money(s_after['net']) in text(page, '#summary-list'), text(page, '#summary-list'))
    shot(page, '03-清單與作廢')

    # 月份切換
    page.fill('#list-month', '2020-01')
    page.wait_for_timeout(600)
    check('切到沒有資料的月份顯示空狀態',
          page.evaluate("() => !document.getElementById('list-empty').hidden"))
    page.fill('#list-month', data['month'])
    page.wait_for_timeout(600)


def run_export(page, data):
    click(page, '#tabs [data-view="export"]', '切到匯出')
    page.wait_for_selector('#view-export:not([hidden])')
    page.wait_for_timeout(300)
    CM.scan(page, '匯出')

    rows = rows_state(page)
    live = [r for r in rows if r['status'] != '作廢']
    matrix = page.evaluate("() => window.Exporter.buildMatrix(window.App.State.rows)")
    headers = ['店別', '日期', '收支別', '科目', '項目名稱', '未稅價', '稅額', '金額',
               '發票', '收據編號', '收據照片', '填表人', '登記時間']
    check('匯出標題列 13 欄正確', matrix[0] == headers, matrix[0])
    check('匯出筆數＝未作廢筆數（%d）' % len(live), len(matrix) - 5 == len(live), len(matrix) - 5)

    # 逐筆比對內容，而不是只數筆數——數量對但內容錯（例如漏掉作廢那筆卻多出別筆）驗不出來。
    # 匯出檔沒有「單號」欄，所以用 日期／收支別／項目名稱／金額 這組當識別。
    data_rows = matrix[1:1 + len(live)]
    got = sorted((r[1], r[2], r[4], r[7]) for r in data_rows)
    want = sorted((r['date'], r['kind'], r['name'], r['amount']) for r in live)
    check('匯出內容與未作廢資料逐筆相符', got == want,
          '差異：%s' % [x for x in got if x not in want][:3])
    voided = [r for r in rows if r['status'] == '作廢']
    check('作廢的那筆沒有出現在匯出檔',
          all((v['date'], v['kind'], v['name'], v['amount']) not in got
              or sum(1 for w in want if w == (v['date'], v['kind'], v['name'], v['amount']))
                 == sum(1 for g in got if g == (v['date'], v['kind'], v['name'], v['amount']))
              for v in voided))
    check('匯出金額欄是數字型別', isinstance(matrix[1][7], (int, float)), type(matrix[1][7]).__name__)

    s = summarize(rows)
    check('匯出支出合計 %d 正確' % s['expense'], matrix[-3][7] == s['expense'], matrix[-3][7])
    check('匯出收入合計 %d 正確' % s['income'], matrix[-2][7] == s['income'], matrix[-2][7])
    check('匯出淨額 %d 正確' % s['net'], matrix[-1][7] == s['net'], matrix[-1][7])

    # 真的按下載，驗檔案內容
    with page.expect_download(timeout=15000) as dl:
        click(page, '#btn-export', '下載檔案')
    download = dl.value
    path = os.path.join(SHOTS, 'export.csv')
    os.makedirs(SHOTS, exist_ok=True)
    download.save_as(path)
    with open(path, encoding='utf-8-sig') as f:
        content = f.read()
    check('下載檔名含店別與月份', data['month'] in download.suggested_filename,
          download.suggested_filename)
    check('下載內容含標題列', '店別,日期,收支別' in content, content[:60])
    check('下載內容筆數與畫面一致',
          len([l for l in content.strip().split('\n') if l.strip()]) == len(matrix) - 1,
          '檔案 %d 行' % len(content.strip().split('\n')))
    shot(page, '04-匯出')


def run_lock(page, data):
    # 鎖定
    page.on('dialog', lambda d: d.accept())
    click(page, '#btn-lock', '鎖定當月')
    page.wait_for_timeout(1200)
    check('鎖定狀態有顯示', '已鎖定' in text(page, '#lock-state'), text(page, '#lock-state'))

    blocked = page.evaluate("""async () => {
      try { await window.Api.create(window.App.State.pass,
        { date: window.App.State.month + '-10', kind: '支出', subject: '雜支',
          name: 'e2e 鎖定後測試', amount: 100, hasInvoice: false });
        return 'created'; } catch (e) { return e.message; }
    }""")
    check('鎖定後後端擋下新增', blocked == 'LOCKED', blocked)

    click(page, '#tabs [data-view="entry"]', '回登記畫面看鎖定提示')
    page.wait_for_timeout(400)
    check('登記畫面顯示已鎖定提示',
          page.evaluate("() => !document.getElementById('entry-locked').hidden"))
    check('鎖定時送出鍵不能按', page.evaluate("() => document.getElementById('btn-submit').disabled"))

    click(page, '#tabs [data-view="list"]', '看清單的鎖定狀態')
    page.wait_for_timeout(400)
    check('鎖定時清單沒有操作鍵',
          page.evaluate("() => document.querySelectorAll('#entry-list [data-act]').length") == 0)

    # 解鎖
    click(page, '#tabs [data-view="export"]', '回匯出頁解鎖')
    page.wait_for_timeout(300)
    click(page, '#btn-lock', '解除鎖定')
    page.wait_for_timeout(1200)
    check('解鎖後回到可編輯', '可以編輯' in text(page, '#lock-state'), text(page, '#lock-state'))
    CM.scan(page, '匯出（解鎖後）')
    shot(page, '05-月結鎖定')


def report_and_exit():
    """登入就掛掉時提早收尾：印出目前為止的結果，不要留一堆例外堆疊。"""
    failed = [r for r in RESULTS if not r[1]]
    print('\n' + '=' * 72)
    print('共 %d 項檢查，通過 %d，失敗 %d（登入失敗，後續未執行）'
          % (len(RESULTS), len(RESULTS) - len(failed), len(failed)))
    for n, _, d in failed:
        print('  ❌ %s　%s' % (n, d))
    print('=' * 72)
    return 1


def report(page):
    rep = CM.report()
    print('\n--- 按鈕與連結覆蓋 ---')
    print('共登記 %d 個可點元素，實際點過 %d 個，刻意略過 %d 個'
          % (rep['total'], rep['clicked'], len(rep['skipped'])))
    for k, why in rep['skipped'].items():
        print('  ⏭  %s：%s' % (k, why))
    if rep['extra']:
        print('  ⚠️  點過但掃描沒登記（key 算法不一致）：%s' % list(rep['extra'])[:5])
    check('每一顆按鈕都點過並驗證', not rep['missed'],
          '漏了 %s' % json.dumps(rep['missed'], ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
