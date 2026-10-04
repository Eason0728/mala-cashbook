#!/usr/bin/env node
'use strict';
// 舊 Apps Script → SQLite 搬資料（spec §8）。在 Mac mini 上跑。
//   OLD_GAS_URL=... OLD_PASS=... node server/tools/migrate.js [--dry-run] [--replace] [--verify-only] [--from 2026-09] [--to YYYY-MM]
// OLD_PASS 只從環境變數讀，絕不印出。exit：0 全過、1 比對不一致或失敗、2 目標 DB 的 rows 非空（未加 --replace）。
const { loadConfig } = require('../config');
const { openDb, setSetting, setMeta, insertImportedRow, insertImportedFrequent, insertImportedLock, taipeiStamp } = require('../db');
const { setStorePass } = require('../auth');

const S = (v) => (v === undefined || v === null ? '' : String(v));
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { dryRun: false, replace: false, verifyOnly: false, from: '2026-09', to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--verify-only') o.verifyOnly = true;
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else throw new Error('未知參數：' + a);
  }
  if (!MONTH_RE.test(String(o.from))) throw new Error('--from 必須是 YYYY-MM');
  if (o.to !== null && !MONTH_RE.test(String(o.to))) throw new Error('--to 必須是 YYYY-MM');
  return o;
}

function monthsBetween(from, to) {
  const out = []; let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(y + '-' + ('0' + m).slice(-2)); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

// POST text/plain JSON；回 HTML 錯誤頁等解析失敗 → 最多重試 3 次（間隔 retryMs）。ok:false 是舊後端的明確回答，不重試。
async function callOld(url, body, retryMs, fetchFn) {
  let lastErr = 'unknown';
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(retryMs);
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch (e) { lastErr = 'HTTP ' + res.status + ' 回應不是 JSON'; continue; }
      if (!j || typeof j !== 'object') { lastErr = '回應格式錯誤'; continue; }
      if (j.ok === false) throw Object.assign(new Error('舊後端回報：' + S(j.error)), { final: true });
      return j;
    } catch (e) {
      if (e.final) throw e;
      lastErr = '連線失敗（' + S(e && e.name) + '）';
    }
  }
  throw new Error('呼叫舊後端失敗（重試 3 次）：' + lastErr);   // 不含網址與通行碼
}

// 一個月的統計：筆數／支出合計／收入合計／作廢筆數（作廢不計入合計）
function emptyStat() { return { count: 0, expense: 0, income: 0, voided: 0 }; }
function addRow(st, kind, amount, status) {
  st.count++;
  if (status === '作廢') { st.voided++; return; }
  if (kind === '收入') st.income += amount; else if (kind === '支出') st.expense += amount;
}
function statsFromOld(rowsByMonth) {
  const out = {};
  for (const m of Object.keys(rowsByMonth)) {
    const st = emptyStat();
    rowsByMonth[m].forEach((r) => addRow(st, S(r.kind), Math.round(N(r.amount)), S(r.status) || '正常'));
    out[m] = st;
  }
  return out;
}
function statsFromDb(db, months) {
  const out = {};
  months.forEach((m) => {
    const st = emptyStat();
    db.prepare('SELECT kind, amount, status FROM rows WHERE substr(date, 1, 7) = ?').all(m).forEach((r) => addRow(st, r.kind, r.amount, r.status));
    out[m] = st;
  });
  return out;
}

function table(oldS, newS, months, w) {
  w('月份     |  舊筆數 新筆數 |   舊支出   新支出 |   舊收入   新收入 | 舊作廢 新作廢 | 結果');
  let ok = true;
  months.forEach((m) => {
    const a = oldS[m], b = newS[m] || emptyStat();
    const same = a.count === b.count && a.expense === b.expense && a.income === b.income && a.voided === b.voided;
    if (!same) ok = false;
    const p = (v, n) => String(v).padStart(n);
    w(`${m}  | ${p(a.count, 7)} ${p(b.count, 6)} | ${p(a.expense, 8)} ${p(b.expense, 8)} | ${p(a.income, 8)} ${p(b.income, 8)} | ${p(a.voided, 6)} ${p(b.voided, 6)} | ${same ? 'OK' : '不一致'}`);
  });
  return ok;
}

// 回傳 exit code。deps：{ env, argv, out, fetch, now }（測試用；CLI 都不傳）
async function main(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const out = deps.out || ((s) => console.log(s));
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || (() => new Date());
  let opts;
  try { opts = parseArgs(deps.argv || process.argv.slice(2)); } catch (e) { out('錯誤：' + e.message); return 1; }
  const url = env.OLD_GAS_URL, pass = env.OLD_PASS;
  if (!url || !pass) { out('錯誤：需要環境變數 OLD_GAS_URL 與 OLD_PASS'); return 1; }
  const retryMs = env.RETRY_MS !== undefined ? Number(env.RETRY_MS) : 3000;
  const to = opts.to || taipeiStamp(now()).slice(0, 7);
  const months = monthsBetween(opts.from, to);
  if (!months.length) { out('錯誤：--from 晚於本月'); return 1; }

  let db = null;
  try {
    // 1. 讀舊端
    const t0 = Date.now();
    const boot = await callOld(url, { action: 'bootstrap', pass }, retryMs, fetchFn);
    const settings = boot.settings || {};
    const frequent = Array.isArray(boot.frequent) ? boot.frequent : [];
    const locked = Array.isArray(boot.lockedMonths) ? boot.lockedMonths.map(S) : [];
    const rowsByMonth = {};
    for (const m of months) {
      const r = await callOld(url, { action: 'list', pass, month: m }, retryMs, fetchFn);
      rowsByMonth[m] = Array.isArray(r.rows) ? r.rows.filter((x) => x && S(x.id)) : [];
    }
    const oldStats = statsFromOld(rowsByMonth);
    const total = months.reduce((a, m) => a + rowsByMonth[m].length, 0);
    out(`讀舊後端完成：${months.length} 個月（${months[0]}～${months[months.length - 1]}）、${total} 筆、常用項目 ${frequent.length}、鎖定月份 ${locked.length}，耗時 ${Date.now() - t0} ms`);

    if (opts.dryRun) {
      out('[dry-run] 只讀不寫。舊端統計：');
      months.forEach((m) => { const s = oldStats[m]; out(`  ${m}  筆數 ${s.count}  支出 ${s.expense}  收入 ${s.income}  作廢 ${s.voided}`); });
      out('[dry-run] 預估寫入：rows ' + total + '、frequent ' + frequent.length + '、locks ' + locked.length + '、科目與店別、店長通行碼雜湊');
      return 0;
    }

    // 2. 寫入
    const cfg = loadConfig(deps.cfgEnv || deps.env);
    db = openDb(cfg.DATA_DIR, now);
    if (!opts.verifyOnly) {
      const existing = db.prepare('SELECT COUNT(*) c FROM rows').get().c;
      if (existing > 0 && !opts.replace) { out(`拒絕：目標資料庫 rows 已有 ${existing} 筆。要覆蓋請加 --replace（會先清 rows／frequent／locks）`); return 2; }
      db.tx(() => {
        if (opts.replace) { db.exec('DELETE FROM rows; DELETE FROM frequent; DELETE FROM locks; DELETE FROM create_tokens;'); }
        months.forEach((m) => rowsByMonth[m].forEach((r) => insertImportedRow(db, r)));
        frequent.forEach((f) => { if (S(f.subject) && S(f.name)) insertImportedFrequent(db, f); });
        locked.forEach((m) => insertImportedLock(db, m, ''));
        if (settings.store !== undefined) setSetting(db, 'store', S(settings.store));
        if (Array.isArray(settings.expenseSubjects)) setSetting(db, 'expense_subjects', JSON.stringify(settings.expenseSubjects.map(S)));
        if (Array.isArray(settings.incomeSubjects)) setSetting(db, 'income_subjects', JSON.stringify(settings.incomeSubjects.map(S)));
        setStorePass(db, pass);   // 沿用同一組店長通行碼（只存雜湊）
        setMeta(db, 'migrated_at', taipeiStamp(now()));
      });
      out(`寫入完成：rows ${total}、frequent ${frequent.length}、locks ${locked.length}`);
    }

    // 3. 比對（讀回新 DB）
    const newStats = statsFromDb(db, months);
    const ok = table(oldStats, newStats, months, out);
    out(ok ? '比對全過' : '比對失敗：舊新兩邊不一致，不要切換網址');
    return ok ? 0 : 1;
  } catch (e) {
    out('失敗：' + S(e && e.message).split(pass).join('***'));
    return 1;
  } finally { if (db) { try { db.close(); } catch (e) { /* */ } } }
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { main, parseArgs, monthsBetween, callOld };
