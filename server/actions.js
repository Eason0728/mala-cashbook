'use strict';
// 八個動作＋adminGet/adminSave。行為逐條對照 apps-script/Code.gs；差異見檔尾「與 Code.gs 的差異」註解。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getSetting, setSetting, taipeiStamp, STORE_CODE_RE } = require('./db');
const { AuthError, setStorePass, setAdminPass } = require('./auth');

class ActionError extends Error { constructor(code) { super(code); this.code = code; } }
const E = (code) => new ActionError(code);

const monthOf = (d) => String(d).slice(0, 7);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const validAmount = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 10000000;
// subject／name：trim 後 1～100 字，否則 BAD_INPUT
function cleanText(v) { const t = String(v === undefined || v === null ? '' : v).trim(); if (t.length < 1 || t.length > 100) throw E('BAD_INPUT'); return t; }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 稅額拆法：與前端 js/calc.js、Code.gs splitTax 完全一致
function splitTax(amount, hasInvoice) {
  const amt = Math.round(Number(amount) || 0);
  if (!hasInvoice) return { net: amt, tax: 0 };
  const net = Math.round(amt / 1.05);
  return { net, tax: amt - net };
}

function toApi(r, withVoid, storeLabel) {
  const o = {
    id: r.id, store: storeLabel === undefined ? r.store : storeLabel, date: r.date, kind: r.kind, subject: r.subject, name: r.name, amount: r.amount,
    hasInvoice: !!r.has_invoice, net: r.net, tax: r.tax, seq: r.seq, photo: r.photo, author: r.author,
    createdAt: r.created_at, status: r.status
  };
  if (withVoid) { o.voidedAt = r.voided_at; o.voidReason = r.void_reason; }   // 同 Code.gs：只有 allRows/findRow 路徑帶這兩欄
  return o;
}

function defaultWritePhoto(dir, token, buf) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, token + '.jpg'), buf, { flag: 'wx' });
}

function createActions({ db, cfg, now, auth, writePhoto, log }) {
  const clock = now || (() => new Date());
  const stamp = () => taipeiStamp(clock());
  const photoDir = path.join(cfg.DATA_DIR, 'photos');
  const putPhoto = writePhoto || defaultWritePhoto;
  const readonlyFile = path.join(cfg.DATA_DIR, 'READONLY');

  const LEGACY = cfg.LEGACY_STORE || db.legacyStore || 'MDGF';
  // ---------- 共用（所有店長動作都帶 store＝門市代號；舊通行碼路徑固定 LEGACY）----------
  const lockedMonths = (store) => db.prepare('SELECT month FROM locks WHERE store = ? AND status = ? ORDER BY locked_at, rowid').all(store, '鎖定').map((r) => r.month);
  function assertOpen(store, month) { if (db.prepare("SELECT 1 FROM locks WHERE store = ? AND month = ? AND status = '鎖定'").get(store, month)) throw E('LOCKED'); }
  function frequentList(store) {
    return db.prepare("SELECT subject, name, count, last_used FROM frequent WHERE store = ? AND subject <> '' AND name <> '' ORDER BY last_used DESC, count DESC, rowid")
      .all(store).map((f) => ({ subject: String(f.subject), name: String(f.name), count: Number(f.count) || 0, lastUsed: String(f.last_used || '') }));
  }
  function bumpFrequent(store, subject, name) {
    db.prepare(`INSERT INTO frequent (store, subject, name, count, last_used) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(store, subject, name) DO UPDATE SET count = count + 1, last_used = excluded.last_used`).run(store, subject, name, stamp());
  }
  const rowsOfMonth = (store, month) => db.prepare('SELECT * FROM rows WHERE store = ? AND substr(date, 1, 7) = ? ORDER BY rowid').all(store, month);
  function findRow(store, id) {
    const r = typeof id === 'string' ? db.prepare('SELECT * FROM rows WHERE id = ? AND store = ?').get(id, store) : null;
    if (!r) throw E('NOT_FOUND');
    return r;
  }
  const subjects = (key) => { try { const a = JSON.parse(getSetting(db, key) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } };
  const storeName = () => getSetting(db, 'store') || '新竹光復';
  // 對外顯示的店別：legacy 維持原本的店名（行為不變），其他店直接用門市代號
  const label = (store) => (store === LEGACY ? storeName() : store);
  const api = (r, withVoid) => toApi(r, withVoid, label(r.store));

  // ---------- 八個動作 ----------
  function bootstrap(req, store) {
    const out = {
      settings: { store: label(store), expenseSubjects: subjects('expense_subjects'), incomeSubjects: subjects('income_subjects') },
      frequent: frequentList(store), lockedMonths: lockedMonths(store)
    };
    if (req && req.month) { out.rows = rowsOfMonth(store, String(req.month)).map((r) => api(r, true)); out.month = req.month; }
    return out;
  }
  function list(req, store) { return { rows: rowsOfMonth(store, String(req.month)).map((r) => api(r, true)) }; }

  function create(req, store) {
    // 冪等：同一個 clientToken 永遠只會有一筆帳（永久保存，不是 6 小時快取）
    let tokenKey = '';
    if (req.clientToken) {
      tokenKey = String(req.clientToken).slice(0, 120);
      const seen = db.prepare('SELECT row_id FROM create_tokens WHERE store = ? AND token = ?').get(store, tokenKey);
      const hit = seen && db.prepare('SELECT * FROM rows WHERE id = ?').get(seen.row_id);
      if (hit) return { row: api(hit, false), frequent: frequentList(store), duplicate: true };   // 不再寫入、不再 bumpFrequent
    }
    const month = monthOf(req.date);
    assertOpen(store, month);
    if (!req.date || !req.subject || !req.name || !(Number(req.amount) > 0)) throw E('BAD_INPUT');
    if (typeof req.date !== 'string' || !DATE_RE.test(req.date) || (req.kind !== '支出' && req.kind !== '收入')) throw E('BAD_INPUT');
    const amountInt = Math.round(Number(req.amount));
    if (!validAmount(amountInt)) throw E('BAD_INPUT');
    const subject = cleanText(req.subject), name = cleanText(req.name);

    const monthRows = rowsOfMonth(store, month);
    let seq = 0;
    monthRows.forEach((r) => { if (r.kind === req.kind && r.seq > seq) seq = r.seq; });
    const t = splitTax(amountInt, req.hasInvoice);
    let n = monthRows.length + 1;
    while (db.prepare('SELECT 1 FROM rows WHERE id = ?').get(month + '-' + ('00' + n).slice(-3))) n++;   // 日期被改到別月後單號可能撞號，往後找空號
    const id = month + '-' + ('00' + n).slice(-3);

    let photoUrl = '', photoFile = '', warning = null;
    if (req.photoBase64) {
      const token = crypto.randomBytes(16).toString('hex');
      try {
        const b64 = String(req.photoBase64).replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('bad base64');
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) throw new Error('empty');
        putPhoto(photoDir, token, buf);
        photoFile = token;
        photoUrl = cfg.PUBLIC_BASE + '/photo/' + token + '.jpg';
      } catch (e) { warning = 'PHOTO_FAIL'; }   // 照片失敗不能害這筆帳記不成
    }
    const row = {
      id, store, date: req.date, kind: req.kind, subject, name,
      amount: amountInt, has_invoice: req.hasInvoice ? 1 : 0, net: t.net, tax: t.tax, seq: seq + 1,
      photo: photoUrl, author: '店長', created_at: stamp(), status: '正常'
    };
    try {
      db.prepare(`INSERT INTO rows (id, store, date, kind, subject, name, amount, has_invoice, net, tax, seq, photo, author, created_at, status, photo_file)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.store, row.date, row.kind, row.subject, row.name, row.amount, row.has_invoice,
        row.net, row.tax, row.seq, row.photo, row.author, row.created_at, row.status, photoFile);
      bumpFrequent(store, row.subject, row.name);
      if (tokenKey) db.prepare('INSERT INTO create_tokens (store, token, row_id, created_at) VALUES (?,?,?,?)').run(store, tokenKey, id, row.created_at);
    } catch (e) {
      if (photoFile) { try { fs.unlinkSync(path.join(photoDir, photoFile + '.jpg')); } catch (e2) { /* 沒檔案 */ } }
      throw e;
    }
    const out = { row: api(row, false), frequent: frequentList(store) };
    if (warning) out.warning = warning;
    return out;
  }

  function update(req, store) {
    const target = findRow(store, req.id);
    assertOpen(store, monthOf(target.date));
    const date = req.date || target.date;
    const amount = req.amount !== undefined ? Math.round(Number(req.amount)) : target.amount;
    const hasInvoice = req.hasInvoice !== undefined ? !!req.hasInvoice : !!target.has_invoice;
    assertOpen(store, monthOf(date));
    const kind = req.kind || target.kind;
    if (typeof date !== 'string' || !DATE_RE.test(date) || !validAmount(amount) || (kind !== '支出' && kind !== '收入')) throw E('BAD_INPUT');
    const t = splitTax(amount, hasInvoice);
    db.prepare('UPDATE rows SET date = ?, kind = ?, subject = ?, name = ?, amount = ?, has_invoice = ?, net = ?, tax = ? WHERE id = ?')
      .run(date, kind, req.subject ? cleanText(req.subject) : target.subject, req.name ? cleanText(req.name) : target.name, amount, hasInvoice ? 1 : 0, t.net, t.tax, target.id);
    return { row: api(findRow(store, req.id), true) };
  }

  // 作廢：只改狀態，資料列永遠留著
  function voidRow(req, store) {
    const target = findRow(store, req.id);
    assertOpen(store, monthOf(target.date));
    const reason = req.reason ? String(req.reason) : '';
    if (reason.length > 200) throw E('BAD_INPUT');
    db.prepare("UPDATE rows SET status = '作廢', voided_at = ?, void_reason = ? WHERE id = ?").run(stamp(), reason, target.id);
    return { row: api(findRow(store, req.id), true) };
  }

  function lock(req, store) {
    if (typeof req.month !== 'string' || !MONTH_RE.test(req.month)) throw E('BAD_INPUT');
    db.prepare("INSERT OR IGNORE INTO locks (store, month, status, locked_at) VALUES (?, ?, '鎖定', ?)").run(store, req.month, stamp());
    return { lockedMonths: lockedMonths(store) };
  }
  function unlock(req, store) {
    db.prepare('DELETE FROM locks WHERE store = ? AND month = ?').run(store, String(req.month));
    return { lockedMonths: lockedMonths(store) };
  }

  // 損益系統唯讀端點：獨立金鑰 PNL_KEY，不走通行碼。長度不同或型別錯一律 AUTH；長度相同才逐位元常數時間比對
  function assertPnlKey(key) {
    const real = cfg.PNL_KEY;
    if (!real || typeof key !== 'string') throw E('AUTH');
    const a = Buffer.from(key), b = Buffer.from(real);
    if (a.byteLength !== b.byteLength || !crypto.timingSafeEqual(a, b)) throw E('AUTH');   // 先比位元組長度，多位元組字元不會丟 RangeError
  }
  function pnlSummary(req) {
    assertPnlKey(req.key);
    const month = req.month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) throw E('BAD_INPUT');
    let store = LEGACY;   // 不帶 store＝光復（舊行為，損益系統不用同時改）
    if (req.store !== undefined && req.store !== null && req.store !== '') {
      if (typeof req.store !== 'string' || !STORE_CODE_RE.test(req.store)) throw E('BAD_INPUT');
      store = req.store;
    }
    const rows = rowsOfMonth(store, month).filter((r) => r.status !== '作廢');
    const expense = {}, income = {};
    let skipped = 0;
    rows.forEach((r) => {
      if (typeof r.amount !== 'number' || !isFinite(r.amount)) { skipped++; return; }
      const bucket = r.kind === '收入' ? income : expense;
      bucket[r.subject] = (bucket[r.subject] || 0) + r.amount;
    });
    return { month, store: label(store), expense, income, rows: rows.length, skipped, locked: lockedMonths(store).indexOf(month) >= 0 };
  }

  // ---------- 設定頁（會計）----------
  const adminView = () => ({ store: storeName(), expenseSubjects: subjects('expense_subjects'), incomeSubjects: subjects('income_subjects') });
  function adminGet() { return adminView(); }   // 永不回任何通行碼或雜湊
  // 會計跨店查帳：只用管理通行碼。店別清單＝有帳或有月結的店＋光復
  function adminStores() {
    const codes = new Set([LEGACY]);
    db.prepare('SELECT DISTINCT store FROM rows').all().forEach((r) => codes.add(r.store));
    db.prepare('SELECT DISTINCT store FROM locks').all().forEach((r) => codes.add(r.store));
    return { stores: [...codes].filter((c) => STORE_CODE_RE.test(c)).sort((a, b) => (a === LEGACY ? -1 : b === LEGACY ? 1 : a < b ? -1 : 1)).map((c) => ({ code: c, name: label(c) })) };
  }
  function adminList(req) {
    if (typeof req.store !== 'string' || !STORE_CODE_RE.test(req.store) || typeof req.month !== 'string' || !MONTH_RE.test(req.month)) throw E('BAD_INPUT');
    return { store: req.store, name: label(req.store), month: req.month, rows: rowsOfMonth(req.store, req.month).map((r) => api(r, true)), locked: lockedMonths(req.store).indexOf(req.month) >= 0 };
  }   // 永不回任何通行碼或雜湊
  function cleanSubjects(v) {
    if (!Array.isArray(v) || v.length === 0 || v.length > 100) throw E('BAD_INPUT');
    const out = [];
    v.forEach((s) => {
      if (typeof s !== 'string') throw E('BAD_INPUT');
      const t = s.trim();
      if (!t || t.length > 30) throw E('BAD_INPUT');
      if (out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }
  const cleanPass = (p) => { if (typeof p !== 'string' || p.length < 4 || p.length > 200) throw E('BAD_INPUT'); return p; };
  function adminSave(req) {
    const exp = req.expenseSubjects !== undefined ? cleanSubjects(req.expenseSubjects) : null;
    const inc = req.incomeSubjects !== undefined ? cleanSubjects(req.incomeSubjects) : null;
    const sp = req.newStorePass !== undefined && req.newStorePass !== null && req.newStorePass !== '' ? cleanPass(req.newStorePass) : null;
    const ap = req.newAdminPass !== undefined && req.newAdminPass !== null && req.newAdminPass !== '' ? cleanPass(req.newAdminPass) : null;
    if (exp) setSetting(db, 'expense_subjects', JSON.stringify(exp));
    if (inc) setSetting(db, 'income_subjects', JSON.stringify(inc));
    if (sp) setStorePass(db, sp);
    if (ap) setAdminPass(db, ap);
    return adminView();
  }

  const STORE_ACTIONS = { bootstrap, list, create, update, void: voidRow, lock, unlock };
  const ADMIN_ACTIONS = { adminGet, adminSave, adminStores, adminList };
  const WRITES = new Set(['create', 'update', 'void', 'lock', 'unlock', 'adminSave']);
  const readonly = () => fs.existsSync(readonlyFile);

  // 入口：回傳 {ok:true,...} 或 {ok:false,error}；HTTP 層永遠 200。寫入包 transaction（單一行程依序執行）。
  // svc＝{ key, code }：HTTP 標頭 X-Store-Key／X-Store-Code。STORE_SVC_KEY 未設時整個忽略（行為與舊版完全相同）。
  function dispatch(req, ip, svc) {
    try {
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw E('BAD_INPUT');
      const action = req.action;
      const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const viaKey = !!cfg.STORE_SVC_KEY && !!svc && typeof svc.key === 'string' && svc.key !== '';
      let fn, store = LEGACY;
      if (viaKey) {
        auth.checkKey(svc.key, cfg.STORE_SVC_KEY, ip);   // 金鑰錯：AUTH_FAIL（計入失敗鎖）
        // 只放行門市端動作；會計／損益動作用金鑰一律拒絕
        if (action === 'pnlSummary' || has(ADMIN_ACTIONS, action)) throw E('FORBIDDEN');
        fn = has(STORE_ACTIONS, action) ? STORE_ACTIONS[action] : null;
        if (!fn) throw E('BAD_INPUT');
        if (typeof svc.code !== 'string' || !STORE_CODE_RE.test(svc.code)) throw E('BAD_INPUT');
        store = svc.code;
      } else if (action === 'pnlSummary') fn = pnlSummary;
      else if (has(ADMIN_ACTIONS, action)) {
        auth.checkAdmin(req.adminPass, ip);
        fn = ADMIN_ACTIONS[action];
      } else {
        if (cfg.STORE_LOGIN_OFF && has(STORE_ACTIONS, action)) throw E('MOVED_TO_STORE_OPS');   // 店長通行碼登入關閉：不論碼對不對
        auth.checkStore(req.pass, ip);
        fn = has(STORE_ACTIONS, action) ? STORE_ACTIONS[action] : null;
        if (!fn) throw E('BAD_INPUT');
      }
      if (WRITES.has(action)) {
        if (readonly()) throw E('READONLY');
        const out = db.tx(() => fn(req, store));
        out.ok = true;
        return out;
      }
      const out = fn(req, store);
      out.ok = true;
      return out;
    } catch (err) {
      if (err instanceof ActionError || err instanceof AuthError) return { ok: false, error: err.code };
      if (log) log('internal-error ' + String(err && err.code || err && err.name || 'unknown'));   // 不記 message，免得夾帶資料
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  return { dispatch, splitTax };
}

/* 與 Code.gs 的差異（刻意）：
 * 1. clientToken 存 create_tokens 永久保存（舊版快取 6 小時）。
 * 2. frequent 依 last_used 由新到舊、再依 count 排序（舊版為試算表列序）。
 * 3. create/update 多檢查：date 必須 YYYY-MM-DD、kind 必須 支出／收入、update 的 amount 必須 >0，否則 BAD_INPUT（舊版會寫入髒資料）。
 * 4. lock 的 month 必須 YYYY-MM，否則 BAD_INPUT。
 * 5. 單號撞號時往後找空號（舊版 update 改月份後可能重複單號；此處 id 是主鍵不能重複）。
 * 6. 照片存本機 photos/<token>.jpg，網址由 PUBLIC_BASE 組成。
 * 7. 新增錯誤碼 AUTH_LOCKED／READONLY／SERVER_ERROR；舊版 BUSY_TRY_AGAIN 不再出現（單一行程依序處理）。
 */
module.exports = { createActions, splitTax, ActionError, toApi };
