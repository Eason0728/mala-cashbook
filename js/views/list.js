/* 當月清單：看、改、作廢。
 * 沒有刪除鍵——送出後的每一筆都留在帳上（2026-09-08 Eason 指示：刪除都要留痕）。
 * 作廢的筆灰掉、劃線、標「已作廢」，不列入合計也不出現在匯出檔，但它還在。
 */
(function () {
  'use strict';

  var editingId = null;
  var openId = null;   // 目前點開哪一列（點開才看得到「修改／作廢」）

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function subjectsFor(kind) {
    var s = window.App.State.settings;
    return kind === '收入' ? s.incomeSubjects : s.expenseSubjects;
  }

  function editForm(r) {
    var opts = subjectsFor(r.kind).map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === r.subject ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    return '' +
      '<div class="actions" style="display:block">' +
        '<label class="field"><span>日期</span><input type="date" data-f="date" value="' + esc(r.date) + '"></label>' +
        '<label class="field"><span>科目</span><select data-f="subject">' + opts + '</select></label>' +
        '<label class="field"><span>項目名稱</span><input type="text" data-f="name" value="' + esc(r.name) + '"></label>' +
        '<label class="field"><span>金額</span><input type="number" data-f="amount" inputmode="numeric" value="' + esc(r.amount) + '"></label>' +
        '<label class="field"><span>單據</span><select data-f="hasInvoice">' +
          '<option value="0"' + (r.hasInvoice ? '' : ' selected') + '>收據／無發票</option>' +
          '<option value="1"' + (r.hasInvoice ? ' selected' : '') + '>統一發票</option>' +
        '</select></label>' +
        '<div class="btn-row">' +
          '<button class="btn btn-sm" data-act="save" data-id="' + esc(r.id) + '" data-busy="儲存中">儲存修改</button>' +
          '<button class="btn btn-secondary btn-sm" data-act="cancel">取消</button>' +
        '</div>' +
      '</div>';
  }

  function rowHTML(r, locked) {
    var voided = r.status === '作廢';
    var cls = 'entry ' + (r.kind === '收入' ? 'income' : 'expense') + (voided ? ' voided' : '');
    var sign = r.kind === '收入' ? '+' : '−';
    var meta = r.subject + '　#' + r.seq + (r.hasInvoice ? '　發票（稅 ' + r.tax + '）' : '　收據') +
               (r.photo ? '　📎' : '');
    // 操作鍵不再每列都掛著——點開那一列才出現，清單本身維持一列一行的密度
    var open = (openId === r.id || editingId === r.id) && !voided && !locked;
    var actions = '';
    if (open) {
      actions = editingId === r.id ? editForm(r) :
        '<div class="actions">' +
          '<button class="btn btn-secondary btn-sm" data-act="edit" data-id="' + esc(r.id) + '">修改</button>' +
          '<button class="btn btn-secondary btn-sm" data-act="void" data-id="' + esc(r.id) + '" data-busy="處理中">作廢</button>' +
        '</div>';
    }
    if (open) cls += ' open';
    return '<li class="' + cls + '" data-id="' + esc(r.id) + '">' +
      '<span class="date">' + esc(r.date.slice(5)) + '</span>' +
      // 徽章不能放在 .name 裡：那一行會截斷長名稱，連帶把「已作廢」三個字一起吃掉
      '<span class="body"><span class="name">' + esc(r.name) + '</span>' +
        '<span class="meta">' + (voided ? '<span class="badge-void">已作廢</span>　' : '') +
        esc(meta) +
        (r.voidReason ? '<br>作廢原因：' + esc(r.voidReason) : '') + '</span></span>' +
      '<span class="amount">' + sign + Number(r.amount).toLocaleString('en-US') +
        (voided || locked ? '' : '<span class="chev">▾</span>') + '</span>' +
      actions +
    '</li>';
  }

  function render() {
    var rows = window.App.State.rows.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;   // 最新的在上面
      return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1;
    });
    var locked = window.App.isLocked(window.App.State.month);
    el('list-locked').textContent = locked ? '這個月已結帳鎖定，只能看不能改。' : '';
    el('list-locked').hidden = !locked;
    el('entry-list').innerHTML = rows.map(function (r) { return rowHTML(r, locked); }).join('');
    el('list-empty').hidden = rows.length > 0;
    window.App.renderSummaries();
  }

  function doVoid(id, btn) {
    if (!window.confirm('作廢這一筆？\n\n作廢不是刪除：這筆會留在帳上並標記為已作廢，只是不再計入合計與匯出檔。')) return;
    var reason = window.prompt('作廢原因（可以不填）：', '') || '';
    return window.Busy.run(btn, function () {
      return window.Api.voidRow(window.App.State.pass, id, reason).then(function (res) {
        window.App.State.rows.forEach(function (r, i) {
          if (r.id === id) window.App.State.rows[i] = res.row;
        });
        render();
      });
    }).catch(function () {});
  }

  function doSave(id, li, btn) {
    var patch = {};
    Array.prototype.forEach.call(li.querySelectorAll('[data-f]'), function (input) {
      var f = input.dataset.f;
      if (f === 'amount') patch.amount = Number(input.value);
      else if (f === 'hasInvoice') patch.hasInvoice = input.value === '1';
      else patch[f] = input.value;
    });
    if (!(patch.amount > 0) || !patch.name.trim()) { window.alert('項目名稱要填，金額要大於 0。'); return; }
    return window.Busy.run(btn, function () {
      return window.Api.update(window.App.State.pass, id, patch).then(function (res) {
        window.App.State.rows.forEach(function (r, i) {
          if (r.id === id) window.App.State.rows[i] = res.row;
        });
        editingId = null;
        openId = null;
        render();
      });
    }).catch(function () {});
  }

  function init() {
    el('list-month').addEventListener('change', function () {
      editingId = null;
      openId = null;
      window.App.loadMonth(el('list-month').value).then(render);
    });

    el('entry-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) {
        // 點在列的空白處＝展開／收合這一列
        var li = e.target.closest('.entry');
        if (!li || li.classList.contains('voided')) return;
        if (e.target.closest('.actions')) return;   // 編輯表單裡的欄位不觸發收合
        openId = (openId === li.dataset.id) ? null : li.dataset.id;
        editingId = null;
        render();
        return;
      }
      var act = btn.dataset.act;
      var li = btn.closest('.entry');
      if (act === 'edit') { editingId = btn.dataset.id; openId = btn.dataset.id; render(); }
      else if (act === 'cancel') { editingId = null; render(); }
      else if (act === 'void') doVoid(btn.dataset.id, btn);
      else if (act === 'save') doSave(btn.dataset.id, li, btn);
    });
  }

  function onShow() { render(); }

  window.ViewList = { init: init, onShow: onShow, render: render };
})();
