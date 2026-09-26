/* 登記畫面：一筆一送。
 * 送出後停在同一頁、清空欄位、日期留著，可以連續打下一筆——
 * 店長通常是拿著一疊收據一次打完，每打一筆就跳走會很難用。
 */
(function () {
  'use strict';

  var photoBase64 = '';

  function el(id) { return document.getElementById(id); }
  function msg(id, text, show) {
    var e = el(id);
    e.textContent = text || '';
    e.hidden = !show;
  }
  function clearMessages() { msg('entry-ok', '', false); msg('entry-error', '', false); }

  function subjects() {
    var s = window.App.State.settings;
    return window.App.State.kind === '收入' ? s.incomeSubjects : s.expenseSubjects;
  }

  function renderSubjects() {
    var sel = el('f-subject'), current = sel.value;
    sel.innerHTML = subjects().map(function (s) {
      return '<option value="' + s + '">' + s + '</option>';
    }).join('');
    if (subjects().indexOf(current) >= 0) sel.value = current;
  }

  /* 候選項目：還沒打字時給最近用過的，打了字就縮成含有那段字的。
     點一下＝帶入名稱並順便把科目也填好。 */
  function renderChips() {
    var box = el('name-chips');
    var items = window.Memory.suggest(el('f-name').value, subjects());
    box.innerHTML = items.map(function (f) {
      // 一律轉字串再處理：試算表會把純數字的名稱回成 Number，直接 .replace 會炸
      var name = String(f.name == null ? '' : f.name);
      var subject = String(f.subject == null ? '' : f.subject);
      var esc = function (t) { return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                                       .replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      return '<button type="button" class="chip" data-name="' + esc(name) +
             '" data-subject="' + esc(subject) + '">' + esc(name) + '</button>';
    }).join('');
  }

  /* 記憶的方向是「項目名稱 → 科目」：打過的名稱自動把科目填好，
     沒打過的就明講沒有紀錄，要自己選一次（選完這次送出後就記起來了）。 */
  function applyMemory() {
    var name = el('f-name').value.trim();
    var hint = el('subject-hint');
    if (!name) { hint.textContent = ''; hint.className = 'hint'; return; }

    var subject = window.Memory.subjectOf(name, subjects());
    if (subject) {
      el('f-subject').value = subject;
      hint.textContent = '依過去紀錄自動帶入「' + subject + '」，不對可以改';
      hint.className = 'hint ok';
      return;
    }
    // 名稱只打到一半時還有候選，就不要跳警告——那只是還沒打完，不是新項目。
    // 真的一個都對不上才提示要自己選科目。
    if (window.Memory.suggest(name, subjects()).length) {
      hint.textContent = '上面有相符的紀錄，點一下就會連科目一起帶入';
      hint.className = 'hint';
    } else {
      hint.textContent = '這是新項目，沒有歷史紀錄——請自己選科目，送出後就會記起來';
      hint.className = 'hint warn';
    }
  }

  function hasInvoice() {
    return el('invoice-toggle').querySelector('[aria-pressed="true"]').dataset.inv === '1';
  }

  function renderTax() {
    var amount = Number(el('f-amount').value) || 0;
    var t = window.Calc.splitTax(amount, hasInvoice());
    el('tax-preview').innerHTML = amount
      ? '未稅 <b>' + t.net.toLocaleString('en-US') + '</b>　稅額 <b>' + t.tax.toLocaleString('en-US') +
        '</b>　合計 <b>' + amount.toLocaleString('en-US') + '</b>'
      : (hasInvoice() ? '有發票：系統會自動拆未稅與稅額' : '沒發票：未稅＝金額，稅額 0');
  }

  function setKind(kind) {
    window.App.State.kind = kind;
    Array.prototype.forEach.call(el('kind-seg').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    });
    renderSubjects();
  }

  function checkLock() {
    var locked = window.App.isLocked(window.App.monthOf(el('f-date').value));
    msg('entry-locked', locked ? '這個月已經結帳鎖定，不能再新增。要改請先在「匯出」頁解除鎖定。' : '', locked);
    el('btn-submit').disabled = locked;
    return locked;
  }

  function clearForm(keepDate) {
    if (!keepDate) el('f-date').value = window.App.todayISO();
    el('f-name').value = '';
    el('f-amount').value = '';
    el('f-photo').value = '';
    photoBase64 = '';
    el('subject-hint').textContent = '';
    el('subject-hint').className = 'hint';
    renderChips();
    renderTax();
  }

  /* 手機拍的收據動輒 3～5MB，直接傳會慢到讓人以為當掉。
     壓到寬 1280、JPEG 0.7——收據上的字還看得清楚，檔案通常降到 200KB 以內。 */
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
        };
        img.onerror = function () { reject(new Error('PHOTO_FAIL')); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('PHOTO_FAIL')); };
      reader.readAsDataURL(file);
    });
  }

  /* 這一次送出的識別碼，後端拿它擋掉重複的第二筆。
     規則：同一份內容重按用同一個，內容一改就換新的。
     為什麼不是每次點擊都發新的：那樣重按照樣會記成第二筆，等於沒做。
     為什麼內容改了一定要換新的：不然店長逾時後改了金額再送，
     會被後端當成同一次送出而擋掉，他的修正就永遠記不進去。 */
  var clientToken = '';
  var tokenFor = '';
  function tokenOf(p) {
    var key = [p.date, p.kind, p.subject, p.name, p.amount, p.hasInvoice ? 1 : 0].join('|');
    if (key !== tokenFor) {
      tokenFor = key;
      clientToken = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    return clientToken;
  }
  // 記成功之後一定要忘掉，否則店長真的買兩次一樣的東西，第二筆會被當成重複擋掉
  function forgetToken() { tokenFor = ''; clientToken = ''; }

  function submit(btn) {
    clearMessages();
    var payload = {
      date: el('f-date').value,
      kind: window.App.State.kind,
      subject: el('f-subject').value,
      name: el('f-name').value.trim(),
      amount: Number(el('f-amount').value),
      hasInvoice: hasInvoice(),
      photoBase64: photoBase64
    };
    if (!payload.date || !payload.name || !(payload.amount > 0)) {
      msg('entry-error', '日期、項目名稱、金額都要填，金額要大於 0。', true);
      return;
    }

    payload.clientToken = tokenOf(payload);

    /* 送出前先記下現在有哪些單號。逾時後要靠這份名單認出「哪一筆是剛剛新增的」，
       用單號差集而不是只比內容——因為店長真的可能連記兩筆一模一樣的。 */
    var knownIds = {};
    window.App.State.rows.forEach(function (r) { knownIds[r.id] = 1; });

    return window.Busy.run(btn, function () {
      return window.Api.create(window.App.State.pass, payload).catch(function (err) {
        if ((err && err.message) !== 'TIMEOUT') throw err;
        /* 逾時只代表瀏覽器不等了，**不代表後端沒寫進去**——它其實常常寫進去了。
           2026-09-24 深夜就是這樣：畫面說沒送出去，店長照著再按，收據 73/74/77、
           79/80/83 兩組各記了三筆。所以這裡不准猜，去查一次當月清單。 */
        return window.Api.list(window.App.State.pass, window.App.monthOf(payload.date))
          .then(function (res) {
            var list = (res && res.rows) || [], found = null;
            for (var i = list.length - 1; i >= 0; i--) {
              var r = list[i];
              if (knownIds[r.id]) continue;              // 送出前就有的，不是這次的
              if (r.date === payload.date && r.kind === payload.kind &&
                  r.subject === payload.subject && r.name === payload.name &&
                  Number(r.amount) === Number(payload.amount)) { found = r; break; }
            }
            if (!found) throw new Error('NOT_SAVED');    // 查過了，確實沒進去
            return { row: found, frequent: res.frequent, rows: list, recovered: true };
          }, function () {
            // 連查都查不到，那就不知道。誠實說不確定，而且絕不叫人再按一次。
            throw new Error('TIMEOUT_UNSURE');
          });
      }).then(function (res) {
        /* 這一筆可能已經在畫面上了：後端擋掉重複（duplicate）或我們自己查回來的
           （recovered），兩種都會拿到既有的那筆。不檢查就會在清單上看到兩列。 */
        var already = window.App.State.rows.some(function (r) { return r.id === res.row.id; });
        if (!already) window.App.State.rows.push(res.row);
        if (res.frequent) { window.App.State.frequent = res.frequent; window.Memory.set(res.frequent); }
        else window.Memory.remember(payload.subject, payload.name);
        window.App.renderSummaries();
        renderChips();
        var done = '已記錄：' + payload.subject + '　' + payload.name + '　$' +
                   payload.amount.toLocaleString('en-US') +
                   '（收據編號 ' + res.row.seq + '）';
        /* 照片失敗不會害這筆帳記不成（後端刻意的），但一定要講出來——
           不講的話店長以為拍了就有存，月底調收據才發現一張都沒有。 */
        if (res.warning === 'PHOTO_FAIL') {
          msg('entry-error', '⚠️ ' + done + '　但這張收據照片沒有存成功，請留著紙本收據。', true);
        } else if (res.recovered || res.duplicate) {
          // 講清楚發生什麼事，不然店長會以為自己按了兩次、跑去清單找重複的
          msg('entry-ok', '這筆其實已經記進去了（收據編號 ' + res.row.seq + '）。'
                        + '剛才只是網路太慢，不是沒記到，不用再按一次。', true);
        } else {
          msg('entry-ok', done, true);
        }
        forgetToken();   // 記成功了，下一筆要用新的識別碼
        clearForm(true); // 日期留著，連續打同一天的收據不用重選
      });
    }, {
      doneText: '已記錄 ✓',
      onError: function (m) { msg('entry-error', m, true); }
    }).catch(function () {});
  }

  function init() {
    el('f-date').value = window.App.todayISO();
    setKind('支出');
    renderChips();
    renderTax();

    Array.prototype.forEach.call(el('kind-seg').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { setKind(b.dataset.kind); clearMessages(); });
    });

    Array.prototype.forEach.call(el('invoice-toggle').querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(el('invoice-toggle').querySelectorAll('button'), function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        renderTax();
      });
    });

    el('f-subject').addEventListener('change', function () {
      // 手動改過科目就把提示收掉，不要繼續宣稱是自動帶入的
      var hint = el('subject-hint');
      if (hint.classList.contains('ok')) { hint.textContent = ''; hint.className = 'hint'; }
    });
    el('f-name').addEventListener('input', function () { renderChips(); applyMemory(); });
    el('f-amount').addEventListener('input', renderTax);
    el('f-date').addEventListener('change', checkLock);

    el('name-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      el('f-name').value = chip.dataset.name;
      if (chip.dataset.subject) el('f-subject').value = chip.dataset.subject;
      applyMemory();
      renderChips();
      el('f-amount').focus();
    });

    el('f-photo').addEventListener('change', function () {
      var file = el('f-photo').files[0];
      photoBase64 = '';
      if (!file) return;
      compress(file).then(function (b64) { photoBase64 = b64; })
                    .catch(function () { msg('entry-error', '這張照片讀不到，換一張或先不拍。', true); });
    });

    el('btn-submit').addEventListener('click', function () { submit(el('btn-submit')); });
    el('btn-clear').addEventListener('click', function () { clearMessages(); clearForm(false); });
  }

  function onShow() { renderSubjects(); renderChips(); renderTax(); checkLock(); }

  window.ViewEntry = { init: init, onShow: onShow };
})();
