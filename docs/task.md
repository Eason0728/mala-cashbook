# 現金收支明細登記系統 — task.md（任務清單）

每個任務控制在 100–200 行內，輸入輸出明確，各自寫得出可打勾的驗收條件。

| # | 任務 | 輸入 | 輸出 | 驗收 |
|---|---|---|---|---|
| T1 | `js/calc.js`：純計算模組（UMD，node 與瀏覽器都能載） | — | `splitTax()`／`summarize()`／`buildExportRows()`／`nextSeq()` | node 載得進來，四個函式都匯出 |
| T2 | `test/logic.test.js`：PASS/FAIL 裁判，含紙本 17 筆 | T1 介面 | `node test/logic.test.js` 印 PASS/FAIL | **功能未寫前先跑一次，必須 FAIL** |
| T3 | `js/config.js` | — | `MODE`／`GAS_URL`／`?mode=local` 覆寫 | `?mode=local` 切得過去 |
| T4 | `js/mock-data.js`：紙本 9 月 17 筆＋設定＋常用項目種子 | 照片資料 | `window.MockData` | 支出 15 筆、收入 2 筆 |
| T5 | `js/api.js`：mock 與 cloud 兩條分支、同一組 Promise 介面 | T3/T4 | `Api.bootstrap/list/create/void/update/lock` | local 模式全部可跑、不碰網路 |
| T6 | `apps-script/Code.gs`：後端四分頁讀寫、稅額、流水號、鎖定 | spec 第二三節 | Web App doPost | 語法檢查過；未部署 |
| T7 | `css/base.css`：小辛辣品牌色語彙 | 品牌色票 | CSS 變數＋元件樣式 | 手機寬度不橫向捲動 |
| T8 | `js/busy.js`：送出中＋秒數 | — | `busy(btn, fn)` | 按下顯示計秒、逾時 20 秒中止不重送 |
| T9 | `js/memory.js`：常用項目記憶 | T5 | 依科目給前 8 個 | 送出後下次同科目出現該項目 |
| T10 | `js/views/login.js`：通行碼 | T5 | 過了存 localStorage | 錯碼進不去 |
| T11 | `js/views/entry.js`：登記表單 | T5/T8/T9 | 一筆一送、清空重填、稅額預覽 | 30 秒內打完一筆 |
| T12 | `js/views/list.js`：清單、三合計、作廢、修改 | T5 | 作廢留痕、不真刪 | 作廢後合計變動、列仍在 |
| T13 | `js/export.js`＋`views/export.js`：xlsx 與月結 | T1/T5 | 檔名與欄位照 spec 第六節 | 匯出筆數與清單相符 |
| T14 | `manifest.json`／`sw.js`／`icons/` | 品牌色 | 可加到主畫面 | standalone 開起來無網址列 |
| T15 | `index.html`：串起全部 | T3–T14 | 單頁四畫面 | 本機起 server 可完整操作 |
| T16 | 回測到 PASS＋截圖 | 全部 | 測試輸出 | 17 筆全對 |
