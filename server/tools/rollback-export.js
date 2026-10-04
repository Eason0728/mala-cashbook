#!/usr/bin/env node
'use strict';
// 回退匯出（ROLLBACK.md）：把 Mac mini 上「切換後新增或修改的列」用 importRows 寫回舊試算表。
//   OLD_GAS_URL=... ROLLBACK_KEY=... node server/tools/rollback-export.js [--dry-run] [--since <台北時間>] [--compare-old]
//   選列規則：created_at 或 voided_at 晚於 --since（沒給就用 meta.migrated_at，migrate.js 正式寫入時記下）。
//   --compare-old：另外用環境變數 OLD_PASS 讀舊後端，凡是跟舊試算表內容不同的列一併送
//                  （抓得到「切換後改過舊帳」，因為 update 不留修改時間）。
// ROLLBACK_KEY／OLD_PASS 只從環境變數讀、絕不印出。exit：0 成功（或 dry-run 完成）、1 失敗。
const { loadConfig } = require('../config');
const { openDb, getMeta, taipeiStamp } = require('../db');
const { callOld, normalizeRow, canonOld, canonDb, FIELDS } = require('./migrate');

const CHUNK = 500;   // 舊後端 importRows 單次上限 2000，留餘裕
const TS_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseArgs(argv) {
  const o = { dryRun: false, since: null, compareOld: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--compare-old') o.compareOld = true;
    else if (a === '--since') o.since = argv[++i];
    else throw new Error('未知參數：' + a);
  }
  return o;
}
// --since 接受台北時間字串，或帶時區的 ISO（轉成台北時間）。字串比較成立的前提是兩邊都是 +08:00 同格式。
function normSince(v) {
  const x = String(v === undefined || v === null ? '' : v).trim();
  if (TS_OK.test(x)) return x;
  if (ISO_TZ.test(x) && !isNaN(Date.parse(x))) return taipeiStamp(new Date(x));
  throw new Error('--since 必須是 YYYY-MM-DDTHH:mm:ss+08:00（或帶時區的 ISO 時間）');
}

// DB 列 → 舊後端 importRows 的物件格式（hasInvoice 一定是 boolean）
function toOldShape(r) {
  return { id: r.id, store: r.store, date: r.date, kind: r.kind, subject: r.subject, name: r.name, amount: r.amount,
    hasInvoice: r.has_invoice === 1, net: r.net, tax: r.tax, seq: r.seq, photo: r.photo, author: r.author,
    createdAt: r.created_at, status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason };
}

async function post(url, body, retryMs, fetchFn) {
  let last = 'unknown';
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, retryMs));
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch (e) { last = 'HTTP ' + res.status + ' 回應不是 JSON'; continue; }
      if (!j || typeof j !== 'object') { last = '回應格式錯誤'; continue; }
      if (j.ok !== true) throw Object.assign(new Error('舊後端回報：' + String(j.error)), { final: true });   // 明確拒絕（AUTH／BAD_INPUT…）不重試
      return j;
    } catch (e) { if (e.final) throw e; last = '連線失敗（' + String(e && e.name) + '）'; }
  }
  throw new Error('呼叫舊後端失敗（重試 3 次）：' + last);   // 不含網址與金鑰
}

// 回傳 exit code。deps：{ env, argv, out, fetch, now }（測試用）
async function main(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const out = deps.out || ((s) => console.log(s));
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || (() => new Date());
  const retryMs = env.RETRY_MS !== undefined ? Number(env.RETRY_MS) : 3000;
  let opts;
  try { opts = parseArgs(deps.argv || process.argv.slice(2)); } catch (e) { out('錯誤：' + e.message); return 1; }
  const url = env.OLD_GAS_URL, key = env.ROLLBACK_KEY;
  if (!url) { out('錯誤：需要環境變數 OLD_GAS_URL'); return 1; }
  if (!opts.dryRun && !key) { out('錯誤：需要環境變數 ROLLBACK_KEY（舊 Apps Script 指令碼屬性的同一把）'); return 1; }
  if (opts.compareOld && !env.OLD_PASS) { out('錯誤：--compare-old 需要環境變數 OLD_PASS（舊店長通行碼）'); return 1; }

  let db = null;
  try {
    const cfg = loadConfig(deps.cfgEnv || env);
    db = openDb(cfg.DATA_DIR, now);
    let since;
    try { since = normSince(opts.since !== null ? opts.since : getMeta(db, 'migrated_at')); }
    catch (e) { out(opts.since !== null ? '錯誤：' + e.message : '錯誤：meta 沒有 migrated_at（遷移時間），請用 --since 指定切換時間'); return 1; }
    out('切換時間點（since）：' + since);

    const all = db.prepare('SELECT * FROM rows ORDER BY rowid').all();
    const picked = new Map(), why = {};
    all.forEach((r) => {
      if (r.created_at > since) { picked.set(r.id, r); why[r.id] = '切換後新增'; }
      else if (r.voided_at && r.voided_at > since) { picked.set(r.id, r); why[r.id] = '切換後作廢'; }
    });
    const byTime = picked.size;

    let byCompare = 0;
    if (opts.compareOld) {
      const months = [...new Set(all.map((r) => r.date.slice(0, 7)))].sort();
      const oldMap = new Map();
      for (const m of months) {
        const r = await callOld(url, { action: 'list', pass: env.OLD_PASS, month: m }, retryMs, fetchFn);
        (Array.isArray(r.rows) ? r.rows : []).forEach((x) => {
          if (!x || x.id === undefined) return;
          const n = normalizeRow(x);
          if (!n.errs.length) oldMap.set(String(x.id), canonOld(n.row));
        });
      }
      all.forEach((r) => {
        if (picked.has(r.id)) return;
        const o = oldMap.get(r.id), n = canonDb(r);
        if (!o || FIELDS.some((f) => o[f] !== n[f])) { picked.set(r.id, r); why[r.id] = o ? '與舊試算表內容不同（切換後被修改）' : '舊試算表沒有這筆'; byCompare++; }
      });
    }

    const rows = [...picked.values()].map(toOldShape);
    out(`要寫回舊試算表的列：${rows.length} 筆（依時間 ${byTime}、依比對舊試算表另外補 ${byCompare}；mini 共 ${all.length} 筆）`);
    rows.slice(0, 50).forEach((r) => out(`  ${r.id}  ${why[r.id]}`));
    if (rows.length > 50) out(`  …另 ${rows.length - 50} 筆`);
    out('提醒：只回寫帳目列；月結鎖定、常用項目不在 importRows 範圍（見 ROLLBACK.md）。');
    if (opts.dryRun) { out('[dry-run] 只讀不寫，沒有呼叫 importRows。'); return 0; }
    if (!rows.length) { out('沒有需要寫回的列，結束。'); return 0; }

    let ins = 0, upd = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await post(url, { action: 'importRows', key, rows: rows.slice(i, i + CHUNK) }, retryMs, fetchFn);
      ins += Number(r.inserted) || 0; upd += Number(r.updated) || 0;
    }
    out(`寫回完成：新增 ${ins}、更新 ${upd}（共送出 ${rows.length}）`);
    if (ins + upd !== rows.length) { out('警告：舊後端回報的筆數與送出的不符，請人工到舊試算表核對'); return 1; }
    return 0;
  } catch (e) {
    out('失敗：' + String(e && e.message).split(key || '\u0000').join('***').split(env.OLD_PASS || '\u0000').join('***'));
    return 1;
  } finally { if (db) { try { db.close(); } catch (e) { /* */ } } }
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { main, parseArgs, normSince, toOldShape };
