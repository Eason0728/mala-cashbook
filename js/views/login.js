/* 登入：一組共用通行碼。過了就記在這支手機上，之後開起來直接進登記畫面。 */
(function () {
  'use strict';

  var KEY = 'cashbook_pass_v1';

  function setError(msg) {
    var el = document.getElementById('login-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function tryLogin(pass, btn) {
    return window.Busy.run(btn, function () {
      return window.Api.bootstrap(pass).then(function (boot) {
        window.App.State.pass = pass;
        try { localStorage.setItem(KEY, pass); } catch (e) {}
        setError('');
        return window.App.afterLogin(boot);
      });
    }, {
      doneText: '進入中…',
      onError: function (msg) {
        setError(msg);
        try { localStorage.removeItem(KEY); } catch (e) {}
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
    if (saved) { input.value = saved; tryLogin(saved, btn); }
  }

  window.ViewLogin = { init: init };
})();
