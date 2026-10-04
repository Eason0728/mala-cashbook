'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, getSetting } = require('../db');
const { verifyPassword } = require('../auth');
const { main } = require('../tools/migrate');
const fake = require('./fake-gas');

const NOW = () => new Date('2026-10-04T12:00:00Z');
async function run(g, dir, argv, extraEnv) {
  const lines = [];
  const env = Object.assign({ DATA_DIR: dir, HOME: dir, OLD_GAS_URL: g.url, OLD_PASS: g.data.pass, RETRY_MS: '10' }, extraEnv || {});
  const code = await main({ env, argv: argv || [], out: (s) => lines.push(s), now: NOW });
  return { code, text: lines.join('\n') };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cashbook-mig-'));

test('migrate：偶發 HTML 錯誤頁重試後，全部寫入且比對全過', async () => {
  const g = await fake.start({ htmlOnce: true }); const dir = tmp();
  try {
    const r = await run(g, dir);
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /比對全過/);
    assert.match(r.text, /2026-09 .*OK/); assert.match(r.text, /2026-10 .*OK/);
    assert.ok(!r.text.includes(g.data.pass), '輸出不得含通行碼');
    const db = openDb(dir, NOW);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rows').get().c, 5);
    assert.match(r.text, /範圍外月份 2026-03/);
    assert.strictEqual(db.prepare("SELECT created_at c FROM rows WHERE id='2026-09-002'").get().c, '2026-09-04T10:00:00+08:00');
    assert.strictEqual(db.prepare("SELECT voided_at c FROM rows WHERE id='2026-09-003'").get().c, '2026-09-05T11:00:00+08:00');
    assert.match(r.text, /逐筆比對：5 筆/);
    const x = db.prepare("SELECT * FROM rows WHERE id = '2026-09-001'").get();
    assert.strictEqual(x.name, '1234'); assert.strictEqual(x.has_invoice, 1); assert.strictEqual(x.photo, 'https://old.example/p1.jpg');
    assert.strictEqual(db.prepare("SELECT status FROM rows WHERE id = '2026-09-003'").get().status, '作廢');
    assert.deepStrictEqual(db.prepare('SELECT month FROM locks').all().map((m) => m.month), ['2026-09']);
    assert.strictEqual(db.prepare("SELECT name FROM frequent WHERE subject='食材'").get().name, '1234');
    assert.deepStrictEqual(JSON.parse(getSetting(db, 'expense_subjects')), ['食材', '1234', '雜支']);
    assert.ok(verifyPassword(g.data.pass, getSetting(db, 'store_pass_hash')));
    assert.ok(!getSetting(db, 'store_pass_hash').includes(g.data.pass));
    db.close();
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：舊端改一筆金額後 --verify-only 比對 → exit 1', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    assert.strictEqual((await run(g, dir)).code, 0);
    g.data.rows[1].amount = 301;
    const r = await run(g, dir, ['--verify-only']);
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /不一致/);
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：--dry-run 不寫 DB', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    const r = await run(g, dir, ['--dry-run']);
    assert.match(r.text, /2026-09-002.*02:00:00\.000Z.*→2026-09-04T10:00:00\+08:00/);
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /dry-run/);
    assert.ok(!fs.existsSync(path.join(dir, 'cashbook.db')), 'dry-run 連資料庫檔都不該建立');
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：rows 非空拒絕 exit 2；--replace 可覆蓋', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    assert.strictEqual((await run(g, dir)).code, 0);
    const r2 = await run(g, dir);
    assert.strictEqual(r2.code, 2, r2.text);
    const r3 = await run(g, dir, ['--replace']);
    assert.strictEqual(r3.code, 0, r3.text);
    const db = openDb(dir, NOW);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rows').get().c, 5);
    db.close();
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：通行碼錯 → exit 1，輸出不含通行碼', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    const r = await run(g, dir, [], { OLD_PASS: 'wrong-pass-zzz' });
    assert.strictEqual(r.code, 1);
    assert.ok(!r.text.includes('wrong-pass-zzz'));
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

async function migrateThenMutate(mut, wantText) {
  const g = await fake.start(); const dir = tmp();
  try {
    assert.strictEqual((await run(g, dir)).code, 0);
    mut(g.data.rows);
    const r = await run(g, dir, ['--verify-only']);
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, wantText, r.text);
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
test('比對：金額對但科目錯 → exit 1 並指出欄位', () => migrateThenMutate((rows) => { rows[0].subject = '雜支'; }, /2026-09-001\.subject/));
test('比對：seq 錯 → exit 1', () => migrateThenMutate((rows) => { rows[1].seq = 9; }, /2026-09-002\.seq/));
test('比對：作廢狀態錯 → exit 1', () => migrateThenMutate((rows) => { rows[2].status = '正常'; }, /2026-09-003\.status/));

test('migrate：重複單號 → 列出並 exit 1，不寫', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    g.data.rows.push(Object.assign({}, g.data.rows[0]));
    const r = await run(g, dir);
    assert.strictEqual(r.code, 1); assert.match(r.text, /2026-09-001 × 2/);
    assert.ok(!fs.existsSync(path.join(dir, 'cashbook.db')));
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：時間解析不了 → 整次中止並印單號', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    g.data.rows[1].createdAt = '昨天下午';
    const r = await run(g, dir);
    assert.strictEqual(r.code, 1); assert.match(r.text, /2026-09-002.*createdAt/);
    assert.ok(!fs.existsSync(path.join(dir, 'cashbook.db')));
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：amount 違規 → exit 1 列出；文字超長 → 警告照搬；超長舊名稱仍可 update 金額', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    g.data.rows[0].amount = 0;
    const r = await run(g, dir);
    assert.strictEqual(r.code, 1); assert.match(r.text, /2026-09-001.*amount/);
    g.data.rows[0].amount = 1050; g.data.rows[4].name = 'x'.repeat(150);
    const r2 = await run(g, dir);
    assert.strictEqual(r2.code, 0, r2.text); assert.match(r2.text, /警告.*2026-10-001/);
    // 以真正的 actions 改金額（只驗有傳的新值）
    const { createActions } = require('../actions'); const { createAuth } = require('../auth'); const { loadConfig } = require('../config');
    const cfg = loadConfig({ DATA_DIR: dir, HOME: dir }); const db = openDb(dir, NOW);
    const act = createActions({ db, cfg, now: NOW, auth: createAuth(db, NOW) });
    const ok = act.dispatch({ action: 'update', pass: g.data.pass, id: '2026-10-001', amount: 400 }, '1.1.1.1');
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(act.dispatch({ action: 'update', pass: g.data.pass, id: '2026-10-001', name: 'y'.repeat(101) }, '1.1.1.1').error, 'BAD_INPUT');
    db.close();
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrate：掃描範圍到本月＋12 個月，2026-12 與本月＋11（2027-09）的資料都搬、比對全過', async () => {
  const g = await fake.start(); const dir = tmp();
  try {
    const mk = (id, date, seq) => Object.assign({}, g.data.rows[3], { id, date, seq, createdAt: date + 'T10:00:00+08:00' });
    g.data.rows.push(mk('2026-12-001', '2026-12-05', 1), mk('2027-09-001', '2027-09-30', 1), mk('2027-11-001', '2027-11-01', 1));
    const r = await run(g, dir);
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /掃描範圍：2026-01～2027-10/);
    assert.match(r.text, /2026-12 .*OK/); assert.match(r.text, /2027-09 .*OK/);
    assert.ok(!/2027-11/.test(r.text.replace(/掃描範圍.*/, '')), '超出範圍的月份不搬');
    const db = openDb(dir, NOW);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM rows WHERE id IN ('2026-12-001','2027-09-001')").get().c, 2);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM rows WHERE id = '2027-11-001'").get().c, 0);
    db.close();
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
