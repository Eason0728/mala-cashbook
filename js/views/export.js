/* 匯出畫面（會計用）：選月份、下載檔案、鎖定月份。 */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function targetMonth() { return el('export-month').value || window.App.State.month; }

  function renderInfo() {
    var month = targetMonth();
    var isCurrent = month === window.App.State.month;
    var s = isCurrent ? window.Calc.summarize(window.App.State.rows) : null;
    var fmt = window.Config.MODE === 'local'
      ? '本機測試模式匯出的是 CSV（Excel 開得起來），正式版才是 .xlsx'
      : '檔名：現金收支_' + window.Config.STORE + '_' + month + '.xlsx';
    el('export-info').innerHTML = s
      ? month + '　共 ' + s.count + ' 筆（作廢的不會匯出）<br>支出 ' + window.App.money(s.expense) +
        '　收入 ' + window.App.money(s.income) + '<br>' + fmt
      : month + '　按下按鈕會先讀取該月資料<br>' + fmt;

    var locked = window.App.isLocked(month);
    el('lock-state').innerHTML = locked
      ? '<span class="badge-lock">' + month + ' 已鎖定</span>'
      : '<span style="font-size:13px;color:var(--muted)">' + month + ' 目前可以編輯</span>';
    el('btn-lock').textContent = locked ? '解除鎖定' : '鎖定這個月';
  }

  function doExport(btn) {
    var month = targetMonth();
    return window.Busy.run(btn, function () {
      // 匯出的一定是後端當下的資料，不是畫面上可能已經過期的那份
      return window.App.loadMonth(month).then(function (rows) {
        if (!window.Calc.summarize(rows).count) throw new Error('BAD_INPUT');
        return window.Exporter.run(window.App.State.pass, month, rows);
      }).then(function () { renderInfo(); });
    }, { doneText: '已下載 ✓' }).catch(function () {});
  }

  function doLock(btn) {
    var month = targetMonth();
    var locked = window.App.isLocked(month);
    if (!locked && !window.confirm('鎖定 ' + month + '？\n\n鎖定後這個月不能再新增、修改或作廢。')) return;
    return window.Busy.run(btn, function () {
      var call = locked ? window.Api.unlock : window.Api.lock;
      return call(window.App.State.pass, month).then(function (res) {
        window.App.State.lockedMonths = res.lockedMonths || [];
        renderInfo();
        window.ViewList.render();
      });
    }, { doneText: locked ? '已解鎖 ✓' : '已鎖定 ✓' }).catch(function () {});
  }

  function init() {
    el('export-month').addEventListener('change', renderInfo);
    el('btn-export').addEventListener('click', function () { doExport(el('btn-export')); });
    el('btn-lock').addEventListener('click', function () { doLock(el('btn-lock')); });
  }

  function onShow() { renderInfo(); }

  window.ViewExport = { init: init, onShow: onShow };
})();
