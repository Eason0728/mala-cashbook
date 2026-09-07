/* 「送出中＋秒數」：所有非同步按鈕都要包這一層（2026-09-08 Eason 指定）
 *
 * 為什麼要顯示秒數：店裡網路時快時慢，沒有回饋的話店長會以為沒按到而連按，
 * 一連按就會記成兩筆帳。看得到秒數在跑，人就會等。
 *
 * 用法：Busy.run(button, function () { return Api.create(...); })
 *       按鈕上加 data-busy="產生中" 可換掉預設的「送出中」字樣。
 */
(function () {
  'use strict';

  var TICK_MS = 100;
  var DONE_HOLD_MS = 1200;

  var MESSAGES = {
    AUTH_FAIL: '通行碼不對',
    LOCKED: '這個月已經結帳鎖定，不能再新增或修改',
    NOT_FOUND: '找不到這筆資料，請重新整理',
    BAD_INPUT: '有欄位沒填或金額不對',
    TIMEOUT: '網路太慢，這次沒送出去，請再按一次',
    SERVER_ERROR: '後端出錯了，請再試一次',
    PHOTO_FAIL: '帳已經記下了，但照片沒上傳成功'
  };

  function messageOf(err) {
    var code = (err && err.message) || 'SERVER_ERROR';
    return MESSAGES[code] || ('出錯了：' + code);
  }

  function run(btn, task, opts) {
    opts = opts || {};
    if (!btn || btn.disabled) return Promise.resolve();

    var original = btn.textContent;
    var label = btn.getAttribute('data-busy') || '送出中';
    var started = Date.now();
    var timer = null;

    function paint() {
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      btn.textContent = label + ' ' + secs + ' 秒';
    }

    btn.disabled = true;
    btn.classList.add('is-busy');
    paint();
    timer = setInterval(paint, TICK_MS);

    function stop() {
      clearInterval(timer);
      btn.classList.remove('is-busy');
    }
    function restore() {
      btn.textContent = original;
      btn.disabled = false;
    }

    return Promise.resolve()
      .then(task)
      .then(function (result) {
        stop();
        btn.textContent = opts.doneText || '已完成 ✓';
        btn.classList.add('is-done');
        setTimeout(function () {
          btn.classList.remove('is-done');
          restore();
        }, DONE_HOLD_MS);
        return result;
      })
      .catch(function (err) {
        stop();
        restore();
        // 失敗一律讓按鈕可以再按，但絕不自動重送——重送會記成兩筆
        if (typeof opts.onError === 'function') opts.onError(messageOf(err), err);
        else window.alert(messageOf(err));
        throw err;
      });
  }

  window.Busy = { run: run, messageOf: messageOf };
})();
