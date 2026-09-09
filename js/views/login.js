/* 登入：一組共用通行碼。過了就記在這支手機上，之後開起來直接進登記畫面。 */
(function () {
  'use strict';

  var KEY = 'cashbook_pass_v1';

  function setError(msg) {
    var el = document.getElementById('login-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* onSnapshot=true 代表畫面上已經用上次的資料開起來了，這一趟是背景更新。
     失敗的處理因此完全不同：不能只在登入頁寫一行紅字，因為他根本沒在看登入頁。 */
  function tryLogin(pass, btn, onSnapshot) {
    var month = window.App.monthOf(window.App.todayISO());
    return window.Busy.run(btn, function () {
      // 一趟就把設定、常用項目、鎖定月份與當月明細全部拿齊（2026-09-10 改，原本要兩趟）
      return window.Api.bootstrap(pass, month).then(function (boot) {
        window.App.State.pass = pass;
        try { localStorage.setItem(KEY, pass); } catch (e) {}
        setError('');
        return window.App.afterLogin(boot);
      });
    }, {
      doneText: '進入中…',
      onError: function (text, err) {
        var code = (err && err.message) || '';
        /* 只有「通行碼被改掉了」才把記住的碼忘掉。網路慢也洗掉的話，
           訊號一差店長就要重打一次碼，而那不是他做錯什麼。 */
        if (code === 'AUTH_FAIL') {
          try { localStorage.removeItem(KEY); } catch (e) {}
          window.App.clearSnapshot();
          window.App.syncBar('');
          window.App.show('login');
          setError(text);
        } else if (onSnapshot) {
          // 舊資料留在畫面上，但要講明白它是舊的、而且現在記不了帳
          window.App.syncBar('連不上後端，看到的是上次的資料，現在記的帳送不出去', true);
        } else {
          setError(text);
        }
      }
    }).catch(function () { /* 錯誤已經顯示在畫面上，不必再往上拋 */ });
  }

  function init() {
    var btn = document.getElementById('btn-login');
    var input = document.getElementById('passcode');

    btn.addEventListener('click', function () { tryLogin(input.value.trim(), btn); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
    });

    // 上次登入過就自動進去——店長每天要開好幾次，不該每次都打碼
    var saved = '';
    try { saved = localStorage.getItem(KEY) || ''; } catch (e) {}
    if (!saved) return;
    input.value = saved;

    /* 有上次的資料就先把畫面開起來，後端在背景更新。
       通行碼是上次驗過的，所以這不是繞過驗證——驗證照打，只是不擋著畫面。 */
    var snap = window.App.readSnapshot();
    if (snap) {
      // 先把碼放進 State：更新還沒回來前他就點進清單去作廢一筆的話，
      // 沒有碼會拿到「通行碼不對」，那句話在這個當下是錯的訊息
      window.App.State.pass = saved;
      window.App.showSnapshot(snap);
    }
    tryLogin(saved, btn, !!snap);
  }

  window.ViewLogin = { init: init };
})();
