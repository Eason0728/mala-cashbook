#!/usr/bin/env node
'use strict';
// 舊 Apps Script → SQLite 搬資料（spec §8）。在 Mac mini 上跑。
//   OLD_GAS_URL=... OLD_PASS=... node server/tools/migrate.js [--dry-run] [--replace] [--verify-only] [--from 2026-01] [--to YYYY-MM]
// OLD_PASS 只從環境變數讀，絕不印出。exit：0 全過、1 比對不一致或失敗、2 目標 DB 的 rows 非空（未加 --replace）。
const { loadConfig } = require('../config');
const { openDb, getSetting, setSetting, setMeta, insertImportedRow, insertImportedFrequent, insertImportedLock, taipeiStamp } = require('../db');
const { setStorePass } = require('../auth');

const S = (v) => (v === undefined || v === null ? '' : String(v));
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { dryRun: false, replace: false, verifyOnly: false, from: '2026-01', to: null };
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

// ---- 欄位正規化（舊試算表的時間欄可能被存成 Date，JSON 回來變成 UTC 的 Z 字串）----
const TS_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function normTs(v) {   // 空 → ''；不能確定時區或解析不了 → 丟錯
  const x = S(v).trim();
  if (x === '') return '';
  if (TS_OK.test(x)) return x;
  if (ISO_TZ.test(x) && !isNaN(Date.parse(x))) return taipeiStamp(new Date(x));
  throw new Error('bad ts');
}
function normDate(v) {
  const x = S(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  if (ISO_TZ.test(x) && !isNaN(Date.parse(x))) return taipeiStamp(new Date(x)).slice(0, 10);
  throw new Error('bad date');
}
const isInv = (v) => v === true || v === 1 || v === '有' || v === '1' || v === 'true';
// 正規化一筆舊列；回 { row, errs:[…] }。errs：BAD_TS（時間解析不了）、BAD_AMOUNT；warns：文字超長
function normalizeRow(r) {
  const errs = [], o = Object.assign({}, r);
  [['date', normDate], ['createdAt', normTs], ['voidedAt', normTs]].forEach(([k, fn]) => { try { o[k] = fn(r[k]); } catch (e) { errs.push(k + ' 無法解析：' + JSON.stringify(S(r[k]))); } });
  const amt = Math.round(N(r.amount));
  if (!Number.isSafeInteger(amt) || amt <= 0) errs.push('amount 不合法：' + S(r.amount));
  return { row: o, errs, longText: S(r.name).trim().length > 100 || S(r.subject).trim().length > 100 };
}
// 比對用：把舊列（已正規化）與新 DB 列都變成同一組字串欄位
const FIELDS = ['id', 'store', 'date', 'kind', 'subject', 'name', 'amount', 'hasInvoice', 'net', 'tax', 'seq', 'photo', 'author', 'createdAt', 'status', 'voidedAt', 'voidReason'];
function canonOld(r) {
  return { id: S(r.id), store: S(r.store), date: S(r.date), kind: S(r.kind), subject: S(r.subject), name: S(r.name), amount: String(Math.round(N(r.amount))),
    hasInvoice: isInv(r.hasInvoice) ? '1' : '0', net: String(Math.round(N(r.net))), tax: String(Math.round(N(r.tax))), seq: String(Math.round(N(r.seq))),
    photo: S(r.photo), author: S(r.author), createdAt: S(r.createdAt), status: S(r.status) || '正常', voidedAt: S(r.voidedAt), voidReason: S(r.voidReason) };
}
function canonDb(r) {
  return { id: r.id, store: r.store, date: r.date, kind: r.kind, subject: r.subject, name: r.name, amount: String(r.amount), hasInvoice: String(r.has_invoice),
    net: String(r.net), tax: String(r.tax), seq: String(r.seq), photo: r.photo, author: r.author, createdAt: r.created_at, status: r.status, voidedAt: r.voided_at, voidReason: r.void_reason };
}

function emptyStat() { return { count: 0, expense: 0, income: 0, voided: 0 }; }
function addRow(st, kind, amount, status) {
  st.count++;
  if (status === '作廢') { st.voided++; return; }
  if (kind === '收入') st.income += amount; else if (kind === '支出') st.expense += amount;
}
function statsFromOld(rowsByMonth) {
  const out = {};
  Object.keys(rowsByMonth).forEach((m) => { const st = emptyStat(); rowsByMonth[m].forEach((r) => addRow(st, S(r.kind), Math.round(N(r.amount)), S(r.status) || '正常')); out[m] = st; });
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

// 逐筆（以 id 為鍵）比全部欄位，另比 frequent、locks、科目、店別。回差異字串陣列。
function diffAll(db, oldRows, oldFreq, oldLocked, settings) {
  const diffs = [];
  const dbRows = new Map(db.prepare('SELECT * FROM rows').all().map((r) => [r.id, canonDb(r)]));
  const oldMap = new Map(oldRows.map((r) => [S(r.id), canonOld(r)]));
  oldMap.forEach((o, id) => {
    const n = dbRows.get(id);
    if (!n) { diffs.push(`${id}：新庫缺這筆`); return; }
    FIELDS.forEach((f) => { if (o[f] !== n[f]) diffs.push(`${id}.${f}：舊=${JSON.stringify(o[f])} 新=${JSON.stringify(n[f])}`); });
  });
  dbRows.forEach((n, id) => { if (!oldMap.has(id)) diffs.push(`${id}：新庫多出這筆`); });
  const key = (s, n) => s + '\u0000' + n;
  const nf = new Map(db.prepare('SELECT * FROM frequent').all().map((f) => [key(f.subject, f.name), `${f.count}|${f.last_used}`]));
  const of = new Map();
  oldFreq.filter((f) => S(f.subject) && S(f.name)).forEach((f) => { let lu = S(f.lastUsed); try { lu = normTs(f.lastUsed); } catch (e) { /* 照原樣 */ } of.set(key(S(f.subject), S(f.name)), `${Math.round(N(f.count))}|${lu}`); });
  of.forEach((v, k) => { if (nf.get(k) !== v) diffs.push(`frequent ${k.replace('\u0000', '/')}：舊=${v} 新=${nf.get(k)}`); });
  nf.forEach((v, k) => { if (!of.has(k)) diffs.push(`frequent ${k.replace('\u0000', '/')}：新庫多出`); });
  const nl = db.prepare('SELECT month FROM locks').all().map((l) => l.month).sort().join(','), ol = oldLocked.slice().sort().join(',');
  if (nl !== ol) diffs.push(`locks：舊=${ol} 新=${nl}`);
  if (settings.store !== undefined && S(settings.store) !== getSetting(db, 'store')) diffs.push('店別不同');
  const sj = (k, a) => { if (Array.isArray(a) && JSON.stringify(a.map(S)) !== getSetting(db, k)) diffs.push(`科目 ${k} 不同`); };
  sj('expense_subjects', settings.expenseSubjects); sj('income_subjects', settings.incomeSubjects);
  return diffs;
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
  const thisMonth = taipeiStamp(now()).slice(0, 7);
  const [ty0, tm0] = thisMonth.split('-').map(Number);
  const nextMonth = tm0 === 12 ? (ty0 + 1) + '-01' : ty0 + '-' + ('0' + (tm0 + 1)).slice(-2);
  const to = opts.to || nextMonth;
  const months = monthsBetween(opts.from, to);
  if (!months.length) { out('錯誤：--from 晚於掃描終點'); return 1; }

  let db = null;
  try {
    // 1. 讀舊端：先 bootstrap，再逐月 list（空月份略過）
    const t0 = Date.now();
    const boot = await callOld(url, { action: 'bootstrap', pass }, retryMs, fetchFn);
    const settings = boot.settings || {};
    const frequent = Array.isArray(boot.frequent) ? boot.frequent : [];
    const locked = Array.isArray(boot.lockedMonths) ? boot.lockedMonths.map(S) : [];
    const rawByMonth = {};
    for (const m of months) {
      const r = await callOld(url, { action: 'list', pass, month: m }, retryMs, fetchFn);
      const rows = Array.isArray(r.rows) ? r.rows.filter((x) => x && S(x.id)) : [];
      if (rows.length) rawByMonth[m] = rows;
    }
    const dataMonths = Object.keys(rawByMonth);
    const total = dataMonths.reduce((a, m) => a + rawByMonth[m].length, 0);
    out(`讀舊後端完成：掃描 ${months[0]}～${months[months.length - 1]}、有資料 ${dataMonths.length} 個月、${total} 筆、常用項目 ${frequent.length}、鎖定月份 ${locked.length}，耗時 ${Date.now() - t0} ms`);
    dataMonths.filter((m) => m < '2026-09' || m > thisMonth).forEach((m) => out(`注意：範圍外月份 ${m} 有 ${rawByMonth[m].length} 筆資料，一併搬入`));

    // 2. 重複單號（不寫）
    const seen = new Map();
    dataMonths.forEach((m) => rawByMonth[m].forEach((r) => seen.set(S(r.id), (seen.get(S(r.id)) || 0) + 1)));
    const dups = [...seen].filter(([, c]) => c > 1);
    if (dups.length) { out('中止：舊端有重複單號（不寫入）：'); dups.forEach(([id, c]) => out(`  ${id} × ${c}`)); return 1; }

    // 3. 正規化＋驗證
    const rowsByMonth = {}, errors = [], longs = [];
    dataMonths.forEach((m) => { rowsByMonth[m] = rawByMonth[m].map((r) => { const n = normalizeRow(r); n.errs.forEach((e) => errors.push(`${S(r.id)}：${e}`)); if (n.longText) longs.push(S(r.id)); return n.row; }); });
    if (errors.length) { out('中止：有資料無法安全搬入（不寫入）：'); errors.forEach((e) => out('  ' + e)); return 1; }
    if (longs.length) out(`警告：${longs.length} 筆的科目或名稱超過 100 字，照搬（之後在新系統改這幾筆時，需重填過長欄位）：${longs.slice(0, 20).join(', ')}`);
    const allRows = dataMonths.reduce((a, m) => a.concat(rowsByMonth[m]), []);
    const oldStats = statsFromOld(rowsByMonth);

    if (opts.dryRun) {
      out('[dry-run] 只讀不寫。舊端統計：');
      dataMonths.forEach((m) => { const s = oldStats[m]; out(`  ${m}  筆數 ${s.count}  支出 ${s.expense}  收入 ${s.income}  作廢 ${s.voided}`); });
      out('[dry-run] 時間欄樣本（前 3 筆，舊原始值 → 正規化後）：');
      dataMonths.reduce((a, m) => a.concat(rawByMonth[m]), []).slice(0, 3).forEach((r, i) => {
        out(`  ${S(r.id)}  date ${JSON.stringify(S(r.date))}→${allRows[i].date}  createdAt ${JSON.stringify(S(r.createdAt))}→${allRows[i].createdAt}  voidedAt ${JSON.stringify(S(r.voidedAt))}→${allRows[i].voidedAt}`);
      });
      out('[dry-run] 預估寫入：rows ' + total + '、frequent ' + frequent.length + '、locks ' + locked.length + '、科目與店別、店長通行碼雜湊');
      return 0;
    }

    // 4. 寫入（單一 transaction）
    const cfg = loadConfig(deps.cfgEnv || deps.env);
    db = openDb(cfg.DATA_DIR, now);
    if (!opts.verifyOnly) {
      const existing = db.prepare('SELECT COUNT(*) c FROM rows').get().c;
      if (existing > 0 && !opts.replace) { out(`拒絕：目標資料庫 rows 已有 ${existing} 筆。要覆蓋請加 --replace（會先清 rows／frequent／locks）`); return 2; }
      db.tx(() => {
        if (opts.replace) { db.exec('DELETE FROM rows; DELETE FROM frequent; DELETE FROM locks; DELETE FROM create_tokens;'); }
        allRows.forEach((r) => insertImportedRow(db, r));
        frequent.forEach((f) => {
          if (!S(f.subject) || !S(f.name)) return;
          let lu = S(f.lastUsed); try { lu = normTs(f.lastUsed); } catch (e) { /* 照原樣 */ }
          insertImportedFrequent(db, Object.assign({}, f, { lastUsed: lu }));
        });
        locked.forEach((m) => insertImportedLock(db, m, ''));
        if (settings.store !== undefined) setSetting(db, 'store', S(settings.store));
        if (Array.isArray(settings.expenseSubjects)) setSetting(db, 'expense_subjects', JSON.stringify(settings.expenseSubjects.map(S)));
        if (Array.isArray(settings.incomeSubjects)) setSetting(db, 'income_subjects', JSON.stringify(settings.incomeSubjects.map(S)));
        setStorePass(db, pass);   // 沿用同一組店長通行碼（只存雜湊）
        setMeta(db, 'migrated_at', taipeiStamp(now()));
      });
      out(`寫入完成：rows ${total}、frequent ${frequent.length}、locks ${locked.length}`);
    }

    // 5. 比對：月合計表＋逐筆逐欄
    const newStats = statsFromDb(db, dataMonths);
    const tableOk = table(oldStats, newStats, dataMonths, out);
    const diffs = diffAll(db, allRows, frequent, locked, settings);
    if (diffs.length) { out(`逐筆比對：${diffs.length} 項差異（列前 20 項）：`); diffs.slice(0, 20).forEach((d) => out('  ' + d)); }
    else out(`逐筆比對：${allRows.length} 筆 × ${FIELDS.length} 欄、frequent、locks、科目、店別，全部相同`);
    const ok = tableOk && diffs.length === 0;
    out(ok ? '比對全過' : '比對失敗：舊新兩邊不一致，不要切換網址');
    return ok ? 0 : 1;
  } catch (e) {
    out('失敗：' + S(e && e.message).split(pass).join('***'));
    return 1;
  } finally { if (db) { try { db.close(); } catch (e) { /* */ } } }
}

if (require.main === module) main().then((c) => process.exit(c));
module.exports = { main, parseArgs, monthsBetween, callOld };
