/* 設定：MODE 切換 mock 本機資料／真 Apps Script 後端（慣例沿用稽核系統 mala-audit）
 * local：js/paper-2026-09.js 的紙本種子資料＋js/api.js 的 mock 分支，通行碼 1234
 * cloud：呼叫 GAS_URL（真試算表；通行碼讀試算表「設定」分頁）
 * 網址加 ?mode=local 可暫時切成假資料模式，不會碰到真試算表——
 * 這也是自動化測試不需要知道正式通行碼的原因。
 */
(function () {
  'use strict';
  var config = {
    MODE: 'cloud',
    STORE: '新竹光復',
    // 2026-09-08 部署（部署 ID AKfycbyelA64…，之後一律 redeploy 同一個 ID）。
    // 這串網址等同鑰匙，所以通行碼是第二道門，且只存在試算表「設定」分頁。
    // 切換到 Mac mini 時改成 https://<funnel 主機>/cashbook/api，步驟見 server/CUTOVER.md
    GAS_URL: 'https://script.google.com/macros/s/AKfycbyelA64WCKft6WhiMZJjtl1egZV3jFUt0eT_MP2KfkkBA7ry9vJEuylIaqC7p_Bk3p56w/exec',
    // 通行碼本身只存試算表「設定」分頁，不寫進程式碼、不進 GitHub。
    REQUIRE_PASSCODE: true,
    // 送出逾時：超過就中止並提示重試，不自動重送（避免記成兩筆）
    /* 匯出 2026-09-09 改成瀏覽器就地產檔，不再打後端，所以這裡只剩
     * 登記／清單／鎖定這些真的要連線的動作在用。 */
    TIMEOUT_MS: 20000,
    /* 唯讀動作（登入、讀清單）逾時或拿到壞回應時會自動重試一次，這是那一次的逾時。
     * 訂得比第一次短的理由：正常回應中位數只有 1.6 秒（2026-09-25 實測 19 發），
     * 12 秒已經是 7 倍容忍度；第二次還超過 12 秒多半是同一波壅塞，
     * 再等下去只是讓店長多盯 8 秒才看到同樣的失敗。 */
    RETRY_TIMEOUT_MS: 12000
  };
  try {
    var m = (location.search.match(/[?&]mode=(local|cloud)\b/) || [])[1];
    if (m) config.MODE = m;
  } catch (e) { /* file:// 直開沒有 location.search */ }
  /* ?api=<url>：只在本機開發（localhost／127.0.0.1）時，才允許用網址參數把後端換成別的位置，
     並強制走 cloud。e2e 靠它打本機 Node server。
     正式網域上一律忽略：否則有人傳一條帶 ?api=惡意網址 的連結，店長打進去的通行碼
     就會被送去別人的伺服器。判斷用 location.hostname 精確比對，不用子字串。 */
  try {
    var host = location.hostname;
    var a = (location.search.match(/[?&]api=([^&]+)/) || [])[1];
    if (a && (host === 'localhost' || host === '127.0.0.1')) {
      config.GAS_URL = decodeURIComponent(a);
      config.MODE = 'cloud';
    }
  } catch (e) { /* file:// 或網址壞掉就當沒帶 */ }
  // 還沒部署後端時自動退回 local，本機開檔不會撞到空網址
  if (config.MODE === 'cloud' && !config.GAS_URL) config.MODE = 'local';
  window.Config = config;
})();
