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
        el('set-admin-pass').value = '';   // 解鎖後輸入框不留管理碼（#5-11）
        el('set-expense').value = (res.expenseSubjects || []).join('\n');
        el('set-income').value = (res.incomeSubjects || []).join('\n');
        ['set-new-store', 'set-new-store2', 'set-new-admin', 'set-new-admin2'].forEach(function (id) { el(id).value = ''; });
        el('set-form').hidden = false;
      });
    }, { doneText: '已讀取 ✓', onError: function (m) { note('set-error', m); } }).catch(function () {});
  }

  var SAVE_UNSURE = '無法確認是否已儲存，不要直接再按一次。請重新整理頁面後進設定頁看一眼科目有沒有變；有換管理通行碼的話，舊碼進不去就改用新碼，有換店長通行碼的話，用新碼登入試試看。';
  var BAD_INPUT_TEXT = '科目或通行碼格式不對（科目 30 字內、最多 100 個；通行碼至少 4 碼、不能有空白）';

  // 存好之後的本機同步：畫面、快照、這台裝置記的碼。真的存好與「逾時後查到其實存好了」共用同一條
  function applySaved(res, payload) {
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
  }

  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

  /* adminSave 逾時：逾時只代表瀏覽器不等了，後端可能已經存好（記帳那條 2026-09-24 的教訓）。
     所以不准猜，查一次再說；寫入本身絕不自動重送。
     查法：先用原管理碼 adminGet，不行再用新管理碼（後端可能已經換了）。
     光看科目一樣不夠——只換通行碼時科目本來就一樣——所以有換碼的話要以「新碼真的能用」為準。
     查不到、或查到的跟送出的對不上，一律說無法確認，絕不叫人再按一次。 */
  function verifySaved(sentPass, payload) {
    var viaNew = false;
    var get = function (p) { return window.Api.adminGet(p); };
    return get(sentPass).catch(function (err) {
      if (!payload.newAdminPass || (err && err.message) === 'TIMEOUT' || (err && err.message) === 'BAD_RESPONSE') throw err;
      return get(payload.newAdminPass).then(function (r) { viaNew = true; return r; });
    }).then(function (res) {
      if (payload.newAdminPass && !viaNew) throw new Error('ADMIN_UNSURE');
      if (!same(res.expenseSubjects, payload.expenseSubjects) || !same(res.incomeSubjects, payload.incomeSubjects)) throw new Error('ADMIN_UNSURE');
      if (!payload.newStorePass) return res;
      var month = window.App.monthOf(window.App.todayISO());
      return window.Api.bootstrap(payload.newStorePass, month).then(function () { return res; });
    }).catch(function () { throw new Error('ADMIN_UNSURE'); });
  }

  function save(btn) {
    note('set-error', ''); note('set-ok', '');
    var exp = lines(el('set-expense').value), inc = lines(el('set-income').value);
    if (!exp.length || !inc.length) { note('set-error', '支出科目、收入科目都至少要有一個'); return; }
    if (exp.length > 100 || inc.length > 100) { note('set-error', '科目最多 100 個（支出、收入各自計算）'); return; }
    var bad = exp.concat(inc).filter(function (s) { return s.length > 30; });
    if (bad.length) { note('set-error', '科目名稱太長（30 字內）：' + bad[0]); return; }
    var payload = { expenseSubjects: exp, incomeSubjects: inc };
    var pairs = [['set-new-store', 'set-new-store2', 'newStorePass', '店長'], ['set-new-admin', 'set-new-admin2', 'newAdminPass', '管理']];
    for (var i = 0; i < pairs.length; i++) {
      var a = el(pairs[i][0]).value, b = el(pairs[i][1]).value;
      if (!a && !b) continue;
      if (a !== b) { note('set-error', '新的' + pairs[i][3] + '通行碼兩次輸入不一樣'); return; }
      /* 空白直接擋：登入畫面會把輸入 trim 掉，含空白的碼在別台裝置永遠打不進去 */
      if (/\s/.test(a)) { note('set-error', '新的' + pairs[i][3] + '通行碼不能含空白'); return; }
      if (a.length < 4) { note('set-error', '新的' + pairs[i][3] + '通行碼至少 4 碼'); return; }
      payload[pairs[i][2]] = a;
    }
    var sentPass = adminPass, recovered = false;
    return window.Busy.run(btn, function () {
      return window.Api.adminSave(sentPass, payload).catch(function (err) {
        if ((err && err.message) !== 'TIMEOUT') throw err;
        return verifySaved(sentPass, payload).then(function (res) { recovered = true; return res; });
      }).then(function (res) {
        applySaved(res, payload);
        note('set-ok', recovered ? '其實已經存好了（剛才只是網路太慢），店長下次登入生效'
                                 : '已儲存，店長下次登入生效');
      });
    }, {
      doneText: '已儲存 ✓',
      onError: function (m, err) {
        var code = err && err.message;
        note('set-error', code === 'ADMIN_UNSURE' ? SAVE_UNSURE : code === 'BAD_INPUT' ? BAD_INPUT_TEXT : m);
      }
    }).catch(function () {});
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

  // 離開設定頁就把管理通行碼從記憶體清掉
  function clear() { adminPass = ''; }

  window.ViewSettings = { init: init, onShow: onShow, clear: clear };
})();
