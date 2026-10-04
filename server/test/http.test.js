'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { tmpEnv, STORE, ADMIN, JPG } = require('./helpers');
const { makeApp } = require('../index');
const { setStorePass } = require('../auth');
const health = require('../health');

let env, app, port, logs = [];
const ORIGIN = 'https://eason0728.github.io';

function req(method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers || {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 圖片 */ } resolve({ status: res.statusCode, headers: res.headers, buf, json }); });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
// 前端 js/api.js 的 post()：Content-Type text/plain 的 JSON body
const api = (obj, h) => req('POST', '/cashbook/api', { body: JSON.stringify(obj), headers: Object.assign({ 'Content-Type': 'text/plain;charset=utf-8', Origin: ORIGIN }, h || {}) });

before(async () => {
  env = tmpEnv({ ALLOW_ORIGIN: 'https://extra.example' });
  app = makeApp(env.cfg, { log: (s) => logs.push(s) });
  setStorePass(app.db, STORE);
  const a = await app.listen(0, '127.0.0.1');
  port = a.port;
});
after(async () => { await app.close(); env.cleanup(); });

test('POST text/plain JSON 可解析，HTTP 200＋{ok:true}；ACAO 只給允許的來源', async () => {
  const r = await api({ action: 'bootstrap', pass: STORE, month: '2026-10' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true); assert.deepStrictEqual(r.json.rows, []);
  assert.strictEqual(r.headers['access-control-allow-origin'], ORIGIN);
  const bad = await api({ action: 'bootstrap', pass: 'x' });
  assert.strictEqual(bad.status, 200); assert.deepStrictEqual(bad.json, { ok: false, error: 'AUTH_FAIL' });
  const evil = await api({ action: 'bootstrap', pass: STORE }, { Origin: 'https://evil.example' });
  assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);
  const extra = await api({ action: 'bootstrap', pass: STORE }, { Origin: 'https://extra.example' });
  assert.strictEqual(extra.headers['access-control-allow-origin'], 'https://extra.example');
});

test('OPTIONS preflight：允許來源回 204＋CORS 標頭，未允許來源無標頭', async () => {
  const ok = await req('OPTIONS', '/cashbook/api', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(ok.status, 204); assert.strictEqual(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.match(ok.headers['access-control-allow-methods'], /POST/); assert.match(ok.headers['access-control-allow-headers'], /Content-Type/i);
  const no = await req('OPTIONS', '/cashbook/api', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(no.status, 204); assert.strictEqual(no.headers['access-control-allow-origin'], undefined);
});

test('壞 JSON／非物件 body → ok:false BAD_INPUT（HTTP 200）', async () => {
  for (const body of ['not json', '[1,2]', 'null', '']) {
    const r = await req('POST', '/cashbook/api', { body, headers: { 'Content-Type': 'text/plain', Origin: ORIGIN } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, { ok: false, error: 'BAD_INPUT' }, body);
  }
});

test('超大 body（>8MB）→ 413 且 ok:false，伺服器仍可用', async () => {
  const big = '{"action":"create","pass":"x","photoBase64":"' + 'A'.repeat(8 * 1024 * 1024 + 10) + '"}';
  const r = await req('POST', '/cashbook/api', { body: big, headers: { 'Content-Type': 'text/plain', Origin: ORIGIN } });
  assert.strictEqual(r.status, 413); assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.error, 'TOO_LARGE');
  assert.strictEqual(r.headers['access-control-allow-origin'], ORIGIN);
  assert.strictEqual((await api({ action: 'bootstrap', pass: STORE })).json.ok, true);
});

test('照片端到端：create 帶 photoBase64 → 網址可 GET 回同一份位元組、image/jpeg', async () => {
  const c = await api({ action: 'create', pass: STORE, date: '2026-10-03', kind: '支出', subject: '瓦斯', name: '桶裝', amount: 100, hasInvoice: false, photoBase64: JPG });
  assert.strictEqual(c.json.ok, true);
  const url = new URL(c.json.row.photo);
  assert.match(url.pathname, /^\/cashbook\/photo\/[0-9a-f]{32}\.jpg$/);
  const g = await req('GET', url.pathname);
  assert.strictEqual(g.status, 200); assert.strictEqual(g.headers['content-type'], 'image/jpeg'); assert.deepStrictEqual(g.buf, Buffer.from(JPG, 'base64'));
});

test('照片路徑：token 格式不符、目錄穿越、不存在一律 404', async () => {
  const paths = ['/cashbook/photo/../../x', '/cashbook/photo/..%2f..%2fetc%2fpasswd', '/cashbook/photo/abc.jpg', '/cashbook/photo/' + 'A'.repeat(32) + '.jpg',
    '/cashbook/photo/' + 'a'.repeat(31) + '.jpg', '/cashbook/photo/' + 'a'.repeat(33) + '.jpg', '/cashbook/photo/' + 'a'.repeat(32) + '.png',
    '/cashbook/photo/' + 'a'.repeat(32) + '.jpg', '/cashbook/photo/', '/cashbook/photo/' + 'a'.repeat(32) + '.jpg/x', '/photo/' + 'a'.repeat(32) + '.jpg', '/', '/cashbook/x', '/cashbook/api'];
  for (const p of paths) { const r = await req('GET', p); assert.strictEqual(r.status, 404, p); }
  // 資料目錄裡的其他檔也拿不到
  fs.writeFileSync(path.join(env.cfg.DATA_DIR, 'secret.txt'), 'x');
  assert.strictEqual((await req('GET', '/cashbook/photo/..%2fsecret.txt')).status, 404);
});

test('health：回 level／reasons／backupAt／rows／diskFreeGB，不含帳目', async () => {
  const r = await req('GET', '/cashbook/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.json).sort(), ['backupAt', 'diskFreeGB', 'level', 'reasons', 'rows']);
  assert.ok(['green', 'yellow', 'red'].includes(r.json.level)); assert.ok(Array.isArray(r.json.reasons));
  assert.strictEqual(typeof r.json.rows, 'number'); assert.strictEqual(r.json.backupAt, null);
  assert.ok(!JSON.stringify(r.json).includes('桶裝'));
});

test('health 判定（純函式）：紅黃綠規則', () => {
  const now = Date.parse('2026-10-05T00:00:00Z'), H = 3600e3, iso = (ago) => new Date(now - ago * H).toISOString();
  const base = { dbOk: true, backupOkAt: iso(2), baselineAt: iso(500), lastResult: 'ok', photosPending: 0, diskFreeGB: 50 };
  assert.deepStrictEqual(health.judge(base, now), { level: 'green', reasons: [] });
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { backupOkAt: iso(27) }), now), { level: 'red', reasons: ['BACKUP_STALE'] });
  assert.strictEqual(health.judge(Object.assign({}, base, { backupOkAt: iso(25) }), now).level, 'green');
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { dbOk: false }), now).reasons, ['DB_DOWN']);
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { diskFreeGB: 1.9 }), now), { level: 'red', reasons: ['DISK_LOW'] });
  assert.strictEqual(health.judge(Object.assign({}, base, { diskFreeGB: 2 }), now).level, 'green');
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { photosPending: 201 }), now), { level: 'yellow', reasons: ['PHOTOS_PENDING'] });
  assert.strictEqual(health.judge(Object.assign({}, base, { photosPending: 200 }), now).level, 'green');
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { lastResult: 'fail', backupOkAt: iso(10) }), now), { level: 'yellow', reasons: ['BACKUP_FAILED'] });
  assert.strictEqual(health.judge(Object.assign({}, base, { lastResult: 'fail', backupOkAt: iso(30) }), now).level, 'red');   // 失敗且上次成功已逾期 → 只剩紅
  assert.deepStrictEqual(health.judge(Object.assign({}, base, { backupOkAt: null, baselineAt: iso(30) }), now).reasons, ['BACKUP_STALE']);   // 從沒備份且已超過 26 小時
  assert.strictEqual(health.judge(Object.assign({}, base, { backupOkAt: null, baselineAt: iso(3) }), now).level, 'green');
});

test('health：備份太久沒成功 → red（透過真 server 的 meta）', async () => {
  app.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backup_ok_at', ?)").run(new Date(Date.now() - 30 * 3600e3).toISOString());
  const r = await req('GET', '/cashbook/health');
  assert.strictEqual(r.json.level, 'red'); assert.deepStrictEqual(r.json.reasons, ['BACKUP_STALE']);
  app.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backup_ok_at', ?)").run(new Date().toISOString());
  assert.strictEqual((await req('GET', '/cashbook/health')).json.level, 'green');
});

test('通行碼失敗鎖依 X-Forwarded-For 第一段', async () => {
  for (let i = 0; i < 20; i++) await api({ action: 'bootstrap', pass: 'bad' }, { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' });
  const locked = await api({ action: 'bootstrap', pass: STORE }, { 'X-Forwarded-For': '203.0.113.9, 10.9.9.9' });
  assert.deepStrictEqual(locked.json, { ok: false, error: 'AUTH_LOCKED' });
  const other = await api({ action: 'bootstrap', pass: STORE }, { 'X-Forwarded-For': '203.0.113.10' });
  assert.strictEqual(other.json.ok, true);
});

test('access log 只有時間、action、ok/錯誤碼、耗時；不含通行碼、body、金額', async () => {
  logs.length = 0;
  await api({ action: 'create', pass: STORE, date: '2026-10-03', kind: '支出', subject: '秘密科目', name: '秘密項目', amount: 31337, hasInvoice: false });
  await api({ action: 'bootstrap', pass: 'wrong-secret-xyz' }, { 'X-Forwarded-For': '198.51.100.1' });
  await req('GET', '/cashbook/health');
  assert.ok(logs.length >= 3);
  for (const l of logs) {
    assert.match(l, /^\d{4}-\d\d-\d\dT[\d:.]+Z (api:\w+|health|photo|notfound) (ok|[A-Z_]+) \d+ms$/, l);
    for (const s of [STORE, 'wrong-secret-xyz', '秘密', '31337', '198.51.100.1']) assert.ok(!l.includes(s), s);
  }
});

test('READONLY 檔：經 HTTP 寫入回 ok:false READONLY', async () => {
  const f = path.join(env.cfg.DATA_DIR, 'READONLY');
  fs.writeFileSync(f, '');
  try {
    const r = await api({ action: 'create', pass: STORE, date: '2026-10-03', kind: '支出', subject: 'a', name: 'b', amount: 1 }, { 'X-Forwarded-For': '192.0.2.77' });
    assert.deepStrictEqual(r.json, { ok: false, error: 'READONLY' });
  } finally { fs.unlinkSync(f); }
});

test('adminGet／adminSave 經 HTTP 可用', async () => {
  const g = await api({ action: 'adminGet', adminPass: ADMIN }, { 'X-Forwarded-For': '192.0.2.50' });
  assert.strictEqual(g.json.ok, true); assert.ok(g.json.expenseSubjects.length > 0);
  assert.ok(!JSON.stringify(g.json).includes(ADMIN));
});
