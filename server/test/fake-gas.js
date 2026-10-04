'use strict';
// 假的舊 Apps Script：POST /exec → 302 → GET /result/<n>（跟真的 GAS 一樣）。可注入偶發 HTML 錯誤頁。
const http = require('node:http');

function defaultData() {
  return {
    pass: 'old-store-pass',
    settings: { store: '新竹光復', expenseSubjects: ['食材', '1234', '雜支'], incomeSubjects: ['回收收入', '其他收入'] },
    frequent: [{ subject: '食材', name: 1234, count: 3, lastUsed: '2026-10-02T09:00:00+08:00' }, { subject: '雜支', name: '膠帶', count: '2', lastUsed: '2026-09-20T09:00:00+08:00' }],
    lockedMonths: ['2026-09'],
    rows: [
      { id: '2026-09-001', store: '新竹光復', date: '2026-09-03', kind: '支出', subject: '食材', name: 1234, amount: 1050, hasInvoice: true, net: 1000, tax: 50, seq: 1, photo: 'https://old.example/p1.jpg', author: '店長', createdAt: '2026-09-03T10:00:00+08:00', status: '正常', voidedAt: '', voidReason: '' },
      { id: '2026-09-002', store: '新竹光復', date: '2026-09-04', kind: '收入', subject: '回收收入', name: '紙箱', amount: 300, hasInvoice: false, net: 300, tax: 0, seq: 1, photo: '', author: '店長', createdAt: '2026-09-04T10:00:00+08:00', status: '正常', voidedAt: '', voidReason: '' },
      { id: '2026-09-003', store: '新竹光復', date: '2026-09-05', kind: '支出', subject: '雜支', name: '膠帶', amount: 99, hasInvoice: false, net: 99, tax: 0, seq: 2, photo: '', author: '店長', createdAt: '2026-09-05T10:00:00+08:00', status: '作廢', voidedAt: '2026-09-05T11:00:00+08:00', voidReason: '記錯' },
      { id: '2026-10-001', store: '新竹光復', date: '2026-10-01', kind: '支出', subject: '食材', name: '豆皮', amount: 500, hasInvoice: false, net: 500, tax: 0, seq: 1, photo: '', author: '店長', createdAt: '2026-10-01T10:00:00+08:00', status: '正常', voidedAt: '', voidReason: '' }
    ]
  };
}

// opts.htmlOnce：第一次呼叫回 Google 風格 HTML 錯誤頁
function start(opts) {
  opts = opts || {};
  const data = defaultData();
  const results = new Map(); let n = 0, htmlLeft = opts.htmlOnce ? 1 : 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/result/')) {
      const body = results.get(req.url) || '{}'; results.delete(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(body);
    }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(buf); } catch (e) { /* */ }
      calls.push(body.action);
      let out;
      if (htmlLeft > 0) { htmlLeft--; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Google 暫時錯誤</body></html>'); }
      if (body.pass !== data.pass) out = { ok: false, error: 'AUTH_FAIL' };
      else if (body.action === 'bootstrap') out = { ok: true, settings: data.settings, frequent: data.frequent, lockedMonths: data.lockedMonths };
      else if (body.action === 'list') out = { ok: true, rows: data.rows.filter((r) => r.date.slice(0, 7) === body.month) };
      else out = { ok: false, error: 'BAD_INPUT' };
      const key = '/result/' + (++n); results.set(key, JSON.stringify(out));
      res.writeHead(302, { Location: key }); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: 'http://127.0.0.1:' + server.address().port + '/exec', data, calls, close: () => new Promise((r) => server.close(r)) });
  }));
}
module.exports = { start };
