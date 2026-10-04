/* 設定（會計用）：科目清單、換通行碼。入口在頁尾，不在店長記帳的主要動線上。
 * 管理通行碼只留在記憶體，不寫進 localStorage（店長的手機不該存有它）。
 * 寫入（adminSave）走 Busy.run，不自動重送。 */
(function () {
  'use strict';

  var adminPass = '';

  function el(id) { return document.getElementById(id); }
  function note(id, msg) { var e = el(id); e.textContent = msg || ''; e.hidden = !msg; }
  function lines(s) {
    var out = [];
    String(s || '').split(/\r?\n/).forEach(function (l) {
      var t = l.trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  function load(btn) {
    note('set-error', ''); note('set-ok', '');
    var pass = el('set-admin-pass').value.trim();
    if (!pass) { note('set-error', '請先輸入管理通行碼'); return; }
    return window.Busy.run(btn, function () {
      return window.Api.adminGet(pass).then(function (res) {
        adminPass = pass;
        el('set-expense').value = (res.expenseSubjects || []).join('\n');
        el('set-income').value = (res.incomeSubjects || []).join('\n');
        ['set-new-store', 'set-new-store2', 'set-new-admin', 'set-new-admin2'].forEach(function (id) { el(id).value = ''; });
        el('set-form').hidden = false;
      });
    }, { doneText: '已讀取 ✓', onError: function (m) { note('set-error', m); } }).catch(function () {});
  }

  function save(btn) {
    note('set-error', ''); note('set-ok', '');
    var exp = lines(el('set-expense').value), inc = lines(el('set-income').value);
    if (!exp.length || !inc.length) { note('set-error', '支出科目、收入科目都至少要有一個'); return; }
    var bad = exp.concat(inc).filter(function (s) { return s.length > 30; });
    if (bad.length) { note('set-error', '科目名稱太長（30 字內）：' + bad[0]); return; }
    var payload = { expenseSubjects: exp, incomeSubjects: inc };
    var pairs = [['set-new-store', 'set-new-store2', 'newStorePass', '店長'], ['set-new-admin', 'set-new-admin2', 'newAdminPass', '管理']];
    for (var i = 0; i < pairs.length; i++) {
      var a = el(pairs[i][0]).value, b = el(pairs[i][1]).value;
      if (!a && !b) continue;
      if (a !== b) { note('set-error', '新的' + pairs[i][3] + '通行碼兩次輸入不一樣'); return; }
      if (a.length < 4) { note('set-error', '新的' + pairs[i][3] + '通行碼至少 4 碼'); return; }
      payload[pairs[i][2]] = a;
    }
    var sentPass = adminPass;
    return window.Busy.run(btn, function () {
      return window.Api.adminSave(sentPass, payload).then(function (res) {
        var S = window.App.State;
        S.settings = Object.assign({}, S.settings, { expenseSubjects: res.expenseSubjects, incomeSubjects: res.incomeSubjects });
        if (payload.newAdminPass) { adminPass = payload.newAdminPass; el('set-admin-pass').value = ''; }
        /* 這台裝置自己換了店長通行碼：把它記的碼一起換掉，不然下次開 app 會被自己擋在門外。
           key 與 js/views/login.js 同一個。 */
        if (payload.newStorePass) {
          S.pass = payload.newStorePass;
          try { localStorage.setItem('cashbook_pass_v1', payload.newStorePass); } catch (e) {}
        }
        window.App.renderSummaries();   // 順手更新快照裡的科目
        el('set-expense').value = res.expenseSubjects.join('\n');
        el('set-income').value = res.incomeSubjects.join('\n');
        ['set-new-store', 'set-new-store2', 'set-new-admin', 'set-new-admin2'].forEach(function (id) { el(id).value = ''; });
        note('set-ok', '已儲存，店長下次登入生效');
      });
    }, { doneText: '已儲存 ✓', onError: function (m) { note('set-error', m); } }).catch(function () {});
  }

  function init() {
    el('btn-open-settings').addEventListener('click', function () { window.App.show('settings'); });
    el('btn-set-load').addEventListener('click', function () { load(el('btn-set-load')); });
    el('btn-set-save').addEventListener('click', function () { save(el('btn-set-save')); });
    el('btn-set-back').addEventListener('click', function () { window.App.show('entry'); });
  }

  // 每次進來都要重新打管理通行碼：離開再回來不留著上次讀到的內容與通行碼
  function onShow() {
    note('set-error', ''); note('set-ok', '');
    adminPass = ''; el('set-admin-pass').value = ''; el('set-form').hidden = true;
  }

  window.ViewSettings = { init: init, onShow: onShow };
})();
