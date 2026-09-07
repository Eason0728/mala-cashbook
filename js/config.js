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
    // 部署 Apps Script 後把網址填進來（現在還沒部署，所以是空字串）
    GAS_URL: '',
    // 通行碼本身只存試算表「設定」分頁，不寫進程式碼、不進 GitHub。
    REQUIRE_PASSCODE: true,
    // 送出逾時：超過就中止並提示重試，不自動重送（避免記成兩筆）
    TIMEOUT_MS: 20000
  };
  try {
    var m = (location.search.match(/[?&]mode=(local|cloud)\b/) || [])[1];
    if (m) config.MODE = m;
  } catch (e) { /* file:// 直開沒有 location.search */ }
  // 還沒部署後端時自動退回 local，本機開檔不會撞到空網址
  if (config.MODE === 'cloud' && !config.GAS_URL) config.MODE = 'local';
  window.Config = config;
})();
