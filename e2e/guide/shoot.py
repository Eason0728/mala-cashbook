# -*- coding: utf-8 -*-
"""為操作圖解截幾張真實畫面（示範模式、注入光復店的假資料）。"""
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.expanduser('~/mala-cashbook')
OUT = os.path.join(ROOT, 'e2e', 'guide')
PORT = 8941
data = json.load(open('/tmp/guide_data.json', encoding='utf-8'))

srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--directory', ROOT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ctx.add_init_script("""
          window.__E2E_DATA = %s;
          const R = Date, F = new R('2026-09-06T10:30:00+08:00').getTime(), o = F - R.now();
          function D(...a){ return a.length ? new R(...a) : new R(R.now()+o); }
          D.prototype = R.prototype; D.now = () => R.now()+o; D.parse = R.parse; D.UTC = R.UTC;
          window.Date = D;
        """ % json.dumps(data, ensure_ascii=False))
        p = ctx.new_page()
        p.goto('http://localhost:%d/?mode=local' % PORT, wait_until='networkidle')
        p.evaluate("() => localStorage.clear()")
        p.reload(wait_until='networkidle')
        p.wait_for_timeout(600)

        p.screenshot(path=os.path.join(OUT, 's1-login.png'))

        p.fill('#passcode', '1234'); p.click('#btn-login')
        p.wait_for_selector('#view-entry:not([hidden])'); p.wait_for_timeout(700)
        p.screenshot(path=os.path.join(OUT, 's2-entry-empty.png'))

        # 填一筆的中途：名稱帶出科目
        p.fill('#f-name', '吉順行—冷藏'); p.wait_for_timeout(400)
        p.fill('#f-amount', '1890'); p.dispatch_event('#f-amount', 'input')
        p.wait_for_timeout(300)
        p.screenshot(path=os.path.join(OUT, 's3-entry-filled.png'))

        p.click('#btn-submit'); p.wait_for_timeout(2000)
        p.evaluate("() => window.scrollTo(0,0)"); p.wait_for_timeout(300)
        p.screenshot(path=os.path.join(OUT, 's4-submitted.png'))

        p.click('#tabs [data-view="list"]'); p.wait_for_timeout(700)
        p.screenshot(path=os.path.join(OUT, 's5-list.png'))

        p.click('#entry-list .entry >> nth=1'); p.wait_for_timeout(400)
        p.evaluate("() => window.scrollTo(0,0)"); p.wait_for_timeout(200)
        p.screenshot(path=os.path.join(OUT, 's6-list-open.png'))

        p.click('#tabs [data-view="export"]'); p.wait_for_timeout(700)
        p.screenshot(path=os.path.join(OUT, 's7-export.png'))
        b.close()
finally:
    srv.terminate()

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
