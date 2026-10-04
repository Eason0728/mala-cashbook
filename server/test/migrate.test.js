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
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rows').get().c, 4);
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
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM rows').get().c, 4);
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
