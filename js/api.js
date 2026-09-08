/* 後端呼叫層：cloud（Apps Script）與 local（mock）兩條分支，對外是同一組 Promise 介面。
 * 上層畫面完全不知道自己在跟誰講話——這是本機測試版能完整操作的原因。
 *
 * cloud 分支照抄稽核系統的作法：POST + Content-Type: text/plain，
 * 用 text/plain 而不是 application/json 是為了不觸發 CORS preflight（Apps Script 不回應 OPTIONS）。
 */
(function () {
  'use strict';

  var MOCK_KEY = 'cashbook_mock_v1';

  // ---------- 共用 ----------
  function fail(code) { return Promise.reject(new Error(code)); }
  function nowISO() {
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '+08:00';
  }
  function monthOf(date) { return String(date || '').slice(0, 7); }

  // ---------- local（mock）：資料存 localStorage，重新整理不會不見 ----------
  function loadDB() {
    try {
      var raw = localStorage.getItem(MOCK_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 無痕模式或壞資料，退回種子 */ }
    var db = {
      rows: window.MockData.rows.map(function (r) { return Object.assign({}, r); }),
      frequent: window.MockData.frequent.map(function (r) { return Object.assign({}, r); }),
      lockedMonths: window.MockData.lockedMonths.slice()
    };
    saveDB(db);
    return db;
  }
  function saveDB(db) {
    try { localStorage.setItem(MOCK_KEY, JSON.stringify(db)); } catch (e) { /* 存不了就只在記憶體 */ }
  }

  function mockAssertOpen(db, month) {
    if (db.lockedMonths.indexOf(month) >= 0) throw new Error('LOCKED');
  }

  function bumpFrequent(db, subject, name) {
    var hit = null;
    db.frequent.forEach(function (f) { if (f.subject === subject && f.name === name) hit = f; });
    if (hit) { hit.count += 1; hit.lastUsed = nowISO(); }
    else db.frequent.push({ subject: subject, name: name, count: 1, lastUsed: nowISO() });
  }

  var mock = {
    bootstrap: function (pass) {
      if (window.Config.REQUIRE_PASSCODE && pass !== window.MockData.passcode) return fail('AUTH_FAIL');
      var db = loadDB();
      return Promise.resolve({
        ok: true, settings: window.MockData.settings,
        frequent: db.frequent, lockedMonths: db.lockedMonths
      });
    },
    list: function (pass, month) {
      var db = loadDB();
      return Promise.resolve({
        ok: true,
        rows: db.rows.filter(function (r) { return monthOf(r.date) === month; })
      });
    },
    create: function (pass, p) {
      var db = loadDB(), month = monthOf(p.date);
      try { mockAssertOpen(db, month); } catch (e) { return fail(e.message); }
      if (!p.date || !p.subject || !p.name || !(Number(p.amount) > 0)) return fail('BAD_INPUT');
      var monthRows = db.rows.filter(function (r) { return monthOf(r.date) === month; });
      var t = window.Calc.splitTax(p.amount, p.hasInvoice);
      var row = {
        id: month + '-' + ('00' + (monthRows.length + 1)).slice(-3),
        store: window.Config.STORE,
        date: p.date, kind: p.kind, subject: p.subject, name: p.name,
        amount: Math.round(Number(p.amount)), hasInvoice: !!p.hasInvoice,
        net: t.net, tax: t.tax,
        seq: window.Calc.nextSeq(monthRows, p.kind),
        photo: p.photoBase64 ? '(本機測試模式：照片不實際上傳)' : '',
        author: '店長', createdAt: nowISO(), status: '正常'
      };
      db.rows.push(row);
      bumpFrequent(db, p.subject, p.name);
      saveDB(db);
      return Promise.resolve({ ok: true, row: row, frequent: db.frequent });
    },
    update: function (pass, id, patch) {
      var db = loadDB(), row = null;
      db.rows.forEach(function (r) { if (r.id === id) row = r; });
      if (!row) return fail('NOT_FOUND');
      try { mockAssertOpen(db, monthOf(row.date)); } catch (e) { return fail(e.message); }
      ['date', 'kind', 'subject', 'name', 'amount', 'hasInvoice'].forEach(function (k) {
        if (patch[k] !== undefined) row[k] = patch[k];
      });
      var t = window.Calc.splitTax(row.amount, row.hasInvoice);
      row.net = t.net; row.tax = t.tax;
      saveDB(db);
      return Promise.resolve({ ok: true, row: row });
    },
    voidRow: function (pass, id, reason) {
      var db = loadDB(), row = null;
      db.rows.forEach(function (r) { if (r.id === id) row = r; });
      if (!row) return fail('NOT_FOUND');
      try { mockAssertOpen(db, monthOf(row.date)); } catch (e) { return fail(e.message); }
      row.status = '作廢';
      row.voidedAt = nowISO();
      row.voidReason = reason || '';
      saveDB(db);
      return Promise.resolve({ ok: true, row: row });
    },
    lock: function (pass, month) {
      var db = loadDB();
      if (db.lockedMonths.indexOf(month) < 0) db.lockedMonths.push(month);
      saveDB(db);
      return Promise.resolve({ ok: true, lockedMonths: db.lockedMonths });
    },
    unlock: function (pass, month) {
      var db = loadDB();
      db.lockedMonths = db.lockedMonths.filter(function (m) { return m !== month; });
      saveDB(db);
      return Promise.resolve({ ok: true, lockedMonths: db.lockedMonths });
    },
    reset: function () { try { localStorage.removeItem(MOCK_KEY); } catch (e) {} return Promise.resolve({ ok: true }); }
  };

  // ---------- cloud（Apps Script） ----------
  /* timeoutMs 不給就用 Config.TIMEOUT_MS。目前沒有呼叫者傳它——匯出改成前端產檔後
     就不需要了——但這個能力留著：一顆按鈕一個門檻，別讓重的動作去遷就輕的動作。 */
  function post(action, body, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var limit = timeoutMs || window.Config.TIMEOUT_MS;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, limit);
    var opt = {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, body))
    };
    if (ctrl) opt.signal = ctrl.signal;
    return fetch(window.Config.GAS_URL, opt)
      /* 不要直接用 res.json()：它失敗時瀏覽器丟的訊息完全看不出原因，
         Safari 更只會說「The string did not match the expected pattern」
         （2026-09-09 店長手機登不進去，就是卡在這句話上查了很久）。
         自己讀成文字再解析，失敗就把後端真正回的內容帶出來。 */
      .then(function (res) {
        return res.text().then(function (raw) {
          try {
            return JSON.parse(raw);
          } catch (e) {
            var bad = new Error('BAD_RESPONSE');
            bad.status = res.status;
            bad.detail = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            throw bad;
          }
        });
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'SERVER_ERROR');
        return data;
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('TIMEOUT');
        throw err;
      })
      .finally(function () { clearTimeout(timer); });
  }

  var cloud = {
    bootstrap: function (pass) { return post('bootstrap', { pass: pass }); },
    list: function (pass, month) { return post('list', { pass: pass, month: month }); },
    create: function (pass, p) { return post('create', Object.assign({ pass: pass }, p)); },
    update: function (pass, id, patch) { return post('update', Object.assign({ pass: pass, id: id }, patch)); },
    voidRow: function (pass, id, reason) { return post('void', { pass: pass, id: id, reason: reason }); },
    lock: function (pass, month) { return post('lock', { pass: pass, month: month }); },
    unlock: function (pass, month) { return post('unlock', { pass: pass, month: month }); },
    reset: function () { return Promise.resolve({ ok: true }); }
  };

  window.Api = { local: mock, cloud: cloud };
  // 依 MODE 決定實際用哪一組，上層只認 window.Api.*
  Object.keys(mock).forEach(function (k) {
    window.Api[k] = function () {
      var impl = window.Config.MODE === 'local' ? mock : cloud;
      return impl[k].apply(impl, arguments);
    };
  });
})();
