'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setup, JPG } = require('./helpers');
const { getMeta } = require('../db');
const { main, HEADERS } = require('../backup');

const KEY = 'bk-key-123';
// 假 BACKUP_URL：攔 payload；failPhoto／failAll 可注入失敗
function startSink(o) {
  o = o || {};
  const got = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); got.push({ raw: b, j });
      const bad = o.failAll || (o.failPhoto && j.action === 'photo');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bad ? { ok: false, code: 'SERVER' } : { ok: true }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ got, url: 'http://127.0.0.1:' + server.address().port + '/x', close: () => new Promise((c) => server.close(c)) })));
}
function env(t, sink, extra) { return Object.assign({ DATA_DIR: t.cfg.DATA_DIR, HOME: t.cfg.DATA_DIR, BACKUP_URL: sink.url, BACKUP_KEY: KEY }, extra || {}); }
async function go(t, sink, extra) {
  const lines = [];
  // 用同一個 DB 檔：先關掉測試的連線再讓 backup 自己開
  const code = await main({ env: env(t, sink, extra), out: (s) => lines.push(s), now: t.clock.now, retryMs: 5 });
  return { code, text: lines.join('\n') };
}
function seed(t) {
  t.call('create', { date: '2026-10-02', kind: '支出', subject: '食材', name: '豆皮', amount: 105, hasInvoice: true, photoBase64: JPG, clientToken: 'a' });
  t.call('create', { date: '2026-10-03', kind: '收入', subject: '回收收入', name: '紙箱', amount: 300, clientToken: 'b' });
  t.call('create', { date: '2026-10-03', kind: '支出', subject: '雜支', name: '膠帶', amount: 50, photoBase64: JPG, clientToken: 'c' });
  t.call('lock', { month: '2026-09' });
  t.db.close();
}
const reopen = (t) => require('../db').openDb(t.cfg.DATA_DIR, t.clock.now);

test('backup：payload 結構正確、不含通行碼／雜湊字樣、照片成功才標、寫 ok、快照存在、舊快照被刪', async () => {
  const t = setup(), sink = await startSink();
  try {
    seed(t);
    const snapDir = path.join(t.cfg.DATA_DIR, 'snapshots'); fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'cashbook-20200101.db'), 'old');          // 遠超過 14 天
    fs.writeFileSync(path.join(snapDir, 'cashbook-20261001.db'), 'recent');        // 3 天前，要留
    const r = await go(t, sink);
    assert.strictEqual(r.code, 0, r.text);
    const data = sink.got.find((g) => g.j.action === 'backup').j;
    assert.deepStrictEqual(data.rows[0], HEADERS); assert.strictEqual(HEADERS.length, 17);
    assert.strictEqual(data.rows.length, 4); assert.ok(data.rows.every((x) => x.length === 17));
    assert.strictEqual(data.rows[1][7], '有');
    assert.strictEqual(data.locks.length, 1); assert.ok(data.frequent.length >= 3);
    assert.ok(data.subjects.expense.includes('食材') && data.subjects.income.includes('其他收入'));
    sink.got.forEach((g) => assert.ok(!/pass|hash|scrypt/i.test(g.raw.replace(/"photo":"[^"]*"/g, '')), '含通行碼字樣'));
    const photos = sink.got.filter((g) => g.j.action === 'photo');
    assert.strictEqual(photos.length, 2);
    assert.match(photos[0].j.name, /^2026-10-001_[0-9a-f]{32}\.jpg$/); assert.strictEqual(photos[0].j.base64, JPG);
    const db = reopen(t);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM rows WHERE photo_file<>'' AND photo_backed_at IS NULL").get().c, 0);
    assert.strictEqual(getMeta(db, 'backup_last_result'), 'ok');
    assert.strictEqual(getMeta(db, 'backup_ok_at'), t.clock.now().toISOString());
    db.close();
    assert.ok(fs.existsSync(path.join(snapDir, 'cashbook-20261004.db')));
    assert.ok(!fs.existsSync(path.join(snapDir, 'cashbook-20200101.db')));
    assert.ok(fs.existsSync(path.join(snapDir, 'cashbook-20261001.db')));
    assert.ok(!r.text.includes('豆皮') && !r.text.includes(KEY), 'log 不得含帳目或金鑰');
  } finally { await sink.close(); t.cleanup(); }
});

test('backup：照片失敗不標 backed、不覆蓋上次成功時間、結果 fail', async () => {
  const t = setup(), sink = await startSink({ failPhoto: true });
  try {
    seed(t);
    let db = reopen(t); db.prepare("INSERT INTO meta (key,value) VALUES ('backup_ok_at','2026-10-03T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(); db.close();
    const r = await go(t, sink);
    assert.strictEqual(r.code, 1, r.text);
    db = reopen(t);
    assert.strictEqual(getMeta(db, 'backup_last_result'), 'fail');
    assert.strictEqual(getMeta(db, 'backup_ok_at'), '2026-10-03T00:00:00.000Z');
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM rows WHERE photo_file<>'' AND photo_backed_at IS NOT NULL").get().c, 0);
    db.close();
  } finally { await sink.close(); t.cleanup(); }
});

test('backup：整批被拒 → fail，backup_ok_at 不動', async () => {
  const t = setup(), sink = await startSink({ failAll: true });
  try {
    seed(t);
    const r = await go(t, sink);
    assert.strictEqual(r.code, 1);
    const db = reopen(t);
    assert.strictEqual(getMeta(db, 'backup_ok_at'), null);
    assert.strictEqual(getMeta(db, 'backup_last_result'), 'fail');
    db.close();
  } finally { await sink.close(); t.cleanup(); }
});

test('backup：BACKUP_URL／BACKUP_KEY 沒設 → fail exit 1，不送任何請求', async () => {
  const t = setup(), sink = await startSink();
  try {
    t.db.close();
    const lines = [];
    const code = await main({ env: { DATA_DIR: t.cfg.DATA_DIR, HOME: t.cfg.DATA_DIR }, out: (s) => lines.push(s), now: t.clock.now });
    assert.strictEqual(code, 1); assert.strictEqual(sink.got.length, 0);
    const db = reopen(t); assert.strictEqual(getMeta(db, 'backup_last_result'), 'fail'); db.close();
  } finally { await sink.close(); t.cleanup(); }
});

test('backup：照片單次最多 50 張，剩下的留待明天', async () => {
  const t = setup(), sink = await startSink();
  try {
    for (let i = 0; i < 52; i++) t.call('create', { date: '2026-10-02', kind: '支出', subject: '食材', name: 'x' + i, amount: 10, photoBase64: JPG, clientToken: 'k' + i });
    t.db.close();
    const r = await go(t, sink);
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(sink.got.filter((g) => g.j.action === 'photo').length, 50);
    const db = reopen(t); assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM rows WHERE photo_file<>'' AND photo_backed_at IS NULL").get().c, 2); db.close();
  } finally { await sink.close(); t.cleanup(); }
});
