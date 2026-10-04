'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { openDb, setMeta, insertImportedRow } = require('../db');
const { main, normSince } = require('../tools/rollback-export');

const NOW = () => new Date('2026-10-10T12:00:00Z');
const KEY = 'rollback-key-xyz', PASS = 'old-store-pass';
const mk = (id, over) => Object.assign({ id, store: '新竹光復', date: '2026-10-02', kind: '支出', subject: '食材', name: '豆皮', amount: 500, hasInvoice: false,
  net: 500, tax: 0, seq: 1, photo: '', author: '店長', createdAt: '2026-10-02T10:00:00+08:00', status: '正常', voidedAt: '', voidReason: '' }, over || {});

// 假舊後端：importRows 以 id upsert；list 回目前試算表內容
function fakeOld(sheetRows) {
  const sheet = new Map(sheetRows.map((r) => [r.id, r])); const posts = [];
  const server = http.createServer((req, res) => {
    let buf = ''; req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const b = JSON.parse(buf); posts.push(b); let out;
      if (b.action === 'importRows') {
        if (b.key !== KEY) out = { ok: false, error: 'AUTH' };
        else { let inserted = 0, updated = 0; b.rows.forEach((r) => { if (sheet.has(r.id)) updated++; else inserted++; sheet.set(r.id, r); }); out = { ok: true, inserted, updated }; }
      } else if (b.action === 'list' && b.pass === PASS) out = { ok: true, rows: [...sheet.values()].filter((r) => r.date.slice(0, 7) === b.month) };
      else out = { ok: false, error: 'AUTH_FAIL' };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/exec', sheet, posts, close: () => new Promise((r) => server.close(r)) })));
}
// mini 的資料庫：遷移時間 2026-10-05 12:00（台北）；切換前 2 筆、切換後新增 2 筆（含 1 筆有發票）、切換前舊帳在切換後被作廢 1 筆、被修改 1 筆
function seedDb(dir) {
  const db = openDb(dir, NOW);
  insertImportedRow(db, mk('2026-10-001'));
  insertImportedRow(db, mk('2026-10-002', { createdAt: '2026-10-03T09:00:00+08:00' }));
  insertImportedRow(db, mk('2026-10-003', { createdAt: '2026-10-03T10:00:00+08:00', status: '作廢', voidedAt: '2026-10-06T09:00:00+08:00', voidReason: '記錯' }));
  insertImportedRow(db, mk('2026-10-004', { createdAt: '2026-10-03T11:00:00+08:00', amount: 777, net: 777 }));   // 切換後被 update（舊試算表是 500）
  insertImportedRow(db, mk('2026-10-005', { date: '2026-10-07', createdAt: '2026-10-07T09:00:00+08:00', hasInvoice: true, amount: 1050, net: 1000, tax: 50, seq: 2 }));
  insertImportedRow(db, mk('2026-10-006', { date: '2026-10-08', kind: '收入', subject: '回收收入', name: '紙箱', createdAt: '2026-10-08T09:00:00+08:00', amount: 300, net: 300 }));
  setMeta(db, 'migrated_at', '2026-10-05T12:00:00+08:00');
  db.close();
}
function oldSheet() {   // 切換當下舊試算表的內容：前 4 筆（004 當時金額 500、003 當時正常）
  return [mk('2026-10-001'), mk('2026-10-002', { createdAt: '2026-10-03T09:00:00+08:00' }), mk('2026-10-003', { createdAt: '2026-10-03T10:00:00+08:00' }),
    mk('2026-10-004', { createdAt: '2026-10-03T11:00:00+08:00' })];
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-rb-'));
async function run(g, dir, argv, extra) {
  const lines = [];
  const env = Object.assign({ DATA_DIR: dir, HOME: dir, OLD_GAS_URL: g.url, ROLLBACK_KEY: KEY, RETRY_MS: '10' }, extra || {});
  const code = await main({ env, argv: argv || [], out: (s) => lines.push(s), now: NOW });
  return { code, text: lines.join('\n') };
}

test('rollback-export：只送切換後新增／作廢的列，hasInvoice 為 boolean，單次 importRows 帶金鑰', async () => {
  const g = await fakeOld(oldSheet()); const dir = tmp(); seedDb(dir);
  try {
    const r = await run(g, dir);
    assert.strictEqual(r.code, 0, r.text);
    const imp = g.posts.filter((p) => p.action === 'importRows');
    assert.strictEqual(imp.length, 1);
    assert.strictEqual(imp[0].key, KEY);
    assert.deepStrictEqual(imp[0].rows.map((x) => x.id), ['2026-10-003', '2026-10-005', '2026-10-006']);   // 切換前新增且沒作廢的 001、002、004 不送
    imp[0].rows.forEach((x) => {
      assert.strictEqual(typeof x.hasInvoice, 'boolean');
      assert.deepStrictEqual(Object.keys(x).sort(), ['amount', 'author', 'createdAt', 'date', 'hasInvoice', 'id', 'kind', 'name', 'net', 'photo', 'seq', 'status', 'store', 'subject', 'tax', 'voidReason', 'voidedAt']);
    });
    assert.strictEqual(imp[0].rows[1].hasInvoice, true); assert.strictEqual(imp[0].rows[2].hasInvoice, false);
    assert.strictEqual(imp[0].rows[0].status, '作廢'); assert.strictEqual(imp[0].rows[0].voidedAt, '2026-10-06T09:00:00+08:00');
    assert.strictEqual(typeof imp[0].rows[1].amount, 'number');
    assert.match(r.text, /寫回完成：新增 2、更新 1/);
    assert.ok(!r.text.includes(KEY), '輸出不得含金鑰');
    assert.strictEqual(g.sheet.get('2026-10-003').status, '作廢');
    assert.strictEqual(g.sheet.get('2026-10-004').amount, 500, '沒開 --compare-old 時，切換後被改金額的舊帳不會被抓（文件有寫要加這個旗標）');
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rollback-export：--compare-old 另抓「切換後被修改的舊帳」', async () => {
  const g = await fakeOld(oldSheet()); const dir = tmp(); seedDb(dir);
  try {
    const r = await run(g, dir, ['--compare-old'], { OLD_PASS: PASS });
    assert.strictEqual(r.code, 0, r.text);
    const imp = g.posts.filter((p) => p.action === 'importRows');
    assert.deepStrictEqual(imp[0].rows.map((x) => x.id).sort(), ['2026-10-003', '2026-10-004', '2026-10-005', '2026-10-006']);
    assert.strictEqual(g.sheet.get('2026-10-004').amount, 777);
    assert.match(r.text, /依比對舊試算表另外補 1/);
    assert.ok(!r.text.includes(PASS));
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rollback-export：--dry-run 不呼叫 importRows、不需要金鑰', async () => {
  const g = await fakeOld(oldSheet()); const dir = tmp(); seedDb(dir);
  try {
    const r = await run(g, dir, ['--dry-run'], { ROLLBACK_KEY: '' });
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /要寫回舊試算表的列：3 筆/); assert.match(r.text, /dry-run/);
    assert.strictEqual(g.posts.length, 0);
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rollback-export：--since 覆蓋 meta；沒有 meta 也沒 --since 就拒絕；金鑰錯誤 exit 1 且不洩漏', async () => {
  const g = await fakeOld(oldSheet()); const dir = tmp(); seedDb(dir);
  try {
    const r1 = await run(g, dir, ['--dry-run', '--since', '2026-10-07T00:00:00+08:00']);
    assert.match(r1.text, /要寫回舊試算表的列：2 筆/);   // 005、006（003 的作廢時間在 10-06，早於 since）
    const r2 = await run(g, dir, ['--since', '2026-10-01T00:00:00Z'], { ROLLBACK_KEY: 'wrong-key' });
    assert.strictEqual(r2.code, 1); assert.match(r2.text, /AUTH/); assert.ok(!r2.text.includes('wrong-key'));
    const r3 = await run(g, dir, ['--bogus']); assert.strictEqual(r3.code, 1);
    const db = openDb(dir, NOW); db.exec("DELETE FROM meta WHERE key='migrated_at'"); db.close();
    const r4 = await run(g, dir, ['--dry-run']); assert.strictEqual(r4.code, 1); assert.match(r4.text, /--since/);
    const r5 = await run(g, dir, [], { ROLLBACK_KEY: '', OLD_GAS_URL: g.url, } ); assert.strictEqual(r5.code, 1);
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rollback-export：超過 500 筆分批送', async () => {
  const g = await fakeOld([]); const dir = tmp();
  try {
    const db = openDb(dir, NOW);
    for (let i = 1; i <= 1100; i++) insertImportedRow(db, mk('2026-10-' + String(i).padStart(4, '0'), { createdAt: '2026-10-06T09:00:00+08:00' }));
    setMeta(db, 'migrated_at', '2026-10-05T12:00:00+08:00'); db.close();
    const r = await run(g, dir);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(g.posts.map((p) => p.rows.length), [500, 500, 100]);
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normSince：台北時間照收、帶時區 ISO 轉台北、其他拒絕', () => {
  assert.strictEqual(normSince('2026-10-05T12:00:00+08:00'), '2026-10-05T12:00:00+08:00');
  assert.strictEqual(normSince('2026-10-05T04:00:00Z'), '2026-10-05T12:00:00+08:00');
  assert.throws(() => normSince('2026-10-05')); assert.throws(() => normSince(null));
});
