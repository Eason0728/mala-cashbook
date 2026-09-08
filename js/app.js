/* 總控：狀態、畫面切換、資料載入。
 * 四個畫面（login / entry / list / export）各自只管自己的 DOM，共用狀態放這裡。
 */
(function () {
  'use strict';

  var State = {
    pass: '',
    settings: { store: '', expenseSubjects: [], incomeSubjects: [] },
    frequent: [],
    lockedMonths: [],
    month: '',
    rows: [],
    kind: '支出'
  };

  function todayISO() {
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function monthOf(dateStr) { return String(dateStr || '').slice(0, 7); }
  function money(n) { return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'); }

  var VIEWS = ['login', 'entry', 'list', 'export'];
  function show(name) {
    VIEWS.forEach(function (v) {
      document.getElementById('view-' + v).hidden = (v !== name);
    });
    var loggedIn = name !== 'login';
    document.getElementById('tabs').hidden = !loggedIn;
    document.getElementById('app-header').hidden = !loggedIn;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === name));
    });
    if (name === 'entry' && window.ViewEntry) window.ViewEntry.onShow();
    if (name === 'list' && window.ViewList) window.ViewList.onShow();
    if (name === 'export' && window.ViewExport) window.ViewExport.onShow();
    window.scrollTo(0, 0);
  }

  function isLocked(month) { return State.lockedMonths.indexOf(month) >= 0; }

  /* 載入某個月的明細。登記畫面與清單畫面共用同一份 rows，
     所以送出一筆之後兩邊的合計會一起更新，不會出現兩個數字打架。 */
  function loadMonth(month) {
    State.month = month;
    return window.Api.list(State.pass, month).then(function (res) {
      State.rows = res.rows || [];
      renderSummaries();
      return State.rows;
    });
  }

  function renderSummaries() {
    var s = window.Calc.summarize(State.rows);
    var html =
      '<div class="expense"><span class="sum-label">本月支出</span>' +
        '<span class="sum-value">' + money(s.expense) + '</span></div>' +
      '<div class="income"><span class="sum-label">本月收入</span>' +
        '<span class="sum-value">' + money(s.income) + '</span></div>' +
      '<div class="net"><span class="sum-label">淨額</span>' +
        '<span class="sum-value' + (s.net < 0 ? ' minus' : '') + '">' + money(s.net) + '</span></div>';
    ['summary-entry', 'summary-list'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  /* 登入成功後才會走到這裡：把設定、常用項目、鎖定月份一次拿齊，再進登記畫面 */
  function afterLogin(boot) {
    State.settings = boot.settings;
    State.frequent = boot.frequent || [];
    State.lockedMonths = boot.lockedMonths || [];
    window.Memory.set(State.frequent);
    document.getElementById('header-store').textContent = State.settings.store || window.Config.STORE;
    var m = monthOf(todayISO());
    document.getElementById('list-month').value = m;
    document.getElementById('export-month').value = m;
    return loadMonth(m).then(function () {
      window.ViewEntry.init();
      show('entry');
    });
  }

  /* 版本號。刻意顯示**快取裡的版本**（＝這台裝置實際在跑的那份程式），
     不是伺服器上的最新版——會問「你手上是哪一版」的場合，要的都是前者。
     兩者不一致就明講該怎麼辦，不要讓人以為自己已經是最新的。 */
  function showVersion() {
    var box = document.getElementById('app-version');
    if (!box) return;
    var installed = null, latest = null;

    var readInstalled = ('caches' in window)
      ? caches.keys().then(function (keys) {
          /* 取**版本號最小**的那個，不是陣列第一個：新版 SW 裝好之後會先在旁邊等，
             舊快取還在、頁面也還是由舊 SW 控制，此時「實際在跑的」是舊的那份。
             caches.keys() 的順序不保證，靠它排就會在該提醒的時候剛好不提醒。 */
          installed = keys.filter(function (k) { return k.indexOf('cashbook-') === 0; })
            .sort(function (a, b) {
              return (parseInt(a.replace(/\D/g, ''), 10) || 0) -
                     (parseInt(b.replace(/\D/g, ''), 10) || 0);
            })[0] || null;
        }).catch(function () {})
      : Promise.resolve();

    var readLatest = fetch('sw.js', { cache: 'no-store' }).then(function (r) { return r.text(); })
      .then(function (t) { latest = (t.match(/VERSION = '([^']+)'/) || [])[1] || null; })
      .catch(function () {});

    Promise.all([readInstalled, readLatest]).then(function () {
      var shown = installed || latest;
      if (!shown) return;                       // file:// 直開之類，沒版本可講就不佔版面
      box.textContent = shown;
      if (installed && latest && installed !== latest) {
        var tip = document.createElement('div');
        tip.className = 'stale';
        tip.textContent = '有新版 ' + latest + '，請把這個畫面完全關掉再重開';
        box.appendChild(tip);
      }
    });
  }

  function init() {
    var banner = document.getElementById('mode-banner');
    if (window.Config.MODE === 'local') {
      // 這句話刻意不寫在 HTML 裡：連結預覽的抓取器會把它當成整個網站的說明
      banner.textContent = '本機測試模式：資料存在這支手機／這台電腦，不會進真的帳本';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    window.Memory.load();

    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });

    window.ViewLogin.init();
    window.ViewList.init();
    window.ViewExport.init();
    show('login');

    showVersion();

    // 註冊 Service Worker：加到手機桌面後開得快，網路不穩時畫面也還打得開。
    // file:// 直開時沒有 SW，不影響任何功能，所以失敗就安靜略過。
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  window.App = {
    State: State, show: show, loadMonth: loadMonth, renderSummaries: renderSummaries,
    afterLogin: afterLogin, isLocked: isLocked, todayISO: todayISO, monthOf: monthOf, money: money
  };

  document.addEventListener('DOMContentLoaded', init);
})();
