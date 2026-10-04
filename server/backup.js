#!/usr/bin/env node
'use strict';
// 每日備份（LaunchDaemon 03:50 跑）：1) DB 快照留 14 天 2) 資料整頁送 Apps Script 3) 補傳還沒備份的照片（單次最多 50 張）
// 成功才寫 meta backup_ok_at＝現在、backup_last_result='ok'；任何失敗只寫 'fail'，不動 backup_ok_at。
// payload 只含帳目、常用項目、月結、科目；絕不含通行碼或雜湊（settings 表只取科目）。log 只記筆數與結果。
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDb, getSetting, setMeta, taipeiStamp } = require('./db');

const HEADERS = ['單號', '店別', '日期', '收支別', '科目', '項目名稱', '金額', '發票', '未稅價', '稅額', '收據編號', '照片連結', '填表人', '登記時間', '狀態', '作廢時間', '作廢原因'];
const MAX_PHOTOS = 50, KEEP_DAYS = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rowToSheet(r) {
  return [r.id, r.store, r.date, r.kind, r.subject, r.name, r.amount, r.has_invoice ? '有' : '無', r.net, r.tax, r.seq, r.photo, r.author, r.created_at, r.status, r.voided_at, r.void_reason];
}
function subjects(db, key) { try { const a = JSON.parse(getSetting(db, key) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } }

function buildPayload(db, key) {
  const rows = [HEADERS].concat(db.prepare('SELECT * FROM rows ORDER BY rowid').all().map(rowToSheet));
  const frequent = db.prepare("SELECT subject, name, count, last_used FROM frequent ORDER BY rowid").all().map((f) => [f.subject, f.name, f.count, f.last_used]);
  const locks = db.prepare('SELECT month, status, locked_at FROM locks ORDER BY rowid').all().map((l) => [l.month, l.status, l.locked_at]);
  return { action: 'backup', key, rows, frequent, locks, subjects: { expense: subjects(db, 'expense_subjects'), income: subjects(db, 'income_subjects') } };
}

// 快照：VACUUM INTO 取得一致的單檔副本（WAL 模式下直接複製檔案會漏資料）
function snapshot(db, dataDir, nowDate) {
  const dir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const ymd = taipeiStamp(nowDate).slice(0, 10).replace(/-/g, '');
  const file = path.join(dir, 'cashbook-' + ymd + '.db');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  // 刪 14 天前的（依檔名日期）
  const cutoff = taipeiStamp(new Date(nowDate.getTime() - KEEP_DAYS * 86400e3)).slice(0, 10).replace(/-/g, '');
  let removed = 0;
  fs.readdirSync(dir).forEach((f) => {
    const m = /^cashbook-(\d{8})\.db$/.exec(f);
    if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) { /* */ } }
  });
  return removed;
}

async function post(url, body, retryMs, fetchFn) {
  let last = 'unknown';
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(retryMs);
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', signal: AbortSignal.timeout(120000) });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch (e) { last = 'HTTP ' + res.status + ' 非 JSON'; continue; }
      if (j && j.ok === true) return j;
      throw Object.assign(new Error('備份端回報 ' + String(j && j.code || j && j.error || '?')), { final: true });
    } catch (e) {
      if (e.final) throw e;
      last = '連線失敗（' + String(e && e.name) + '）';
    }
  }
  throw new Error('呼叫備份端失敗：' + last);
}

// 回傳 exit code（0 成功、1 失敗）。deps：{ env, out, fetch, now }（測試用）
async function main(deps) {
  deps = deps || {};
  const out = deps.out || ((s) => console.log(s));
  const fetchFn = deps.fetch || fetch;
  const nowFn = deps.now || (() => new Date());
  const cfg = loadConfig(deps.env);
  const retryMs = deps.retryMs !== undefined ? deps.retryMs : 3000;
  const db = openDb(cfg.DATA_DIR, nowFn);
  const fail = (msg) => { setMeta(db, 'backup_last_result', 'fail'); out('備份失敗：' + msg); db.close(); return 1; };
  if (!cfg.BACKUP_URL || !cfg.BACKUP_KEY) return fail('BACKUP_URL 或 BACKUP_KEY 沒設');
  let problem = null;
  try {
    const removed = snapshot(db, cfg.DATA_DIR, nowFn());
    out('快照完成，清掉舊快照 ' + removed + ' 個');
  } catch (e) { problem = '快照失敗'; out('快照失敗：' + String(e && e.code || e && e.name)); }   // 快照壞了仍繼續送雲端，最後仍記 fail
  try {
    const payload = buildPayload(db, cfg.BACKUP_KEY);
    await post(cfg.BACKUP_URL, payload, retryMs, fetchFn);
    out(`資料備份完成：rows ${payload.rows.length - 1}、frequent ${payload.frequent.length}、locks ${payload.locks.length}`);
    const pending = db.prepare("SELECT id, photo_file FROM rows WHERE photo_file <> '' AND photo_backed_at IS NULL ORDER BY rowid LIMIT ?").all(MAX_PHOTOS);
    let sent = 0, missing = 0;
    for (const p of pending) {
      const file = path.join(cfg.DATA_DIR, 'photos', p.photo_file + '.jpg');
      let buf; try { buf = fs.readFileSync(file); } catch (e) { missing++; continue; }   // 檔案不見：略過（不標記），不拖累整體結果
      await post(cfg.BACKUP_URL, { action: 'photo', key: cfg.BACKUP_KEY, name: p.id + '_' + p.photo_file + '.jpg', base64: buf.toString('base64') }, retryMs, fetchFn);
      db.prepare('UPDATE rows SET photo_backed_at = ? WHERE id = ?').run(taipeiStamp(nowFn()), p.id);
      sent++;
    }
    const left = db.prepare("SELECT COUNT(*) c FROM rows WHERE photo_file <> '' AND photo_backed_at IS NULL").get().c;
    out(`照片備份：本次 ${sent} 張、檔案遺失 ${missing} 張、尚待 ${left} 張`);
  } catch (e) { problem = String(e && e.message || 'error'); }
  if (problem) return fail(problem);
  setMeta(db, 'backup_ok_at', nowFn().toISOString());
  setMeta(db, 'backup_last_result', 'ok');
  out('備份成功');
  db.close();
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('備份失敗：' + String(e && e.name)); process.exit(1); });
module.exports = { main, buildPayload, HEADERS };
