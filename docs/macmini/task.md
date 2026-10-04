# 任務清單：現金收支登記｜後端搬到 Mac mini
共用契約見 plan.md。每個任務完成＝驗收條件逐項附實際指令與輸出。

## P1 伺服器核心
- **T1 config＋db**（`server/config.js`、`server/db.js`）：開 SQLite、建 spec §3 六張表、初始設定（店別「新竹光復」、科目預設照 Code.gs setup）。
  驗收：`node --test server/test/db.test.js`：建表冪等（開兩次不壞）、transaction 失敗會回滾。
- **T2 八個動作**（`server/actions.js`）：bootstrap/list/create/update/void/lock/unlock/pnlSummary，行為逐條對照 `apps-script/Code.gs`；clientToken 存 `create_tokens`；照片寫檔失敗回 `warning:'PHOTO_FAIL'` 但帳照記。
  驗收：`server/test/actions.test.js` 覆蓋：稅額（有/無發票）、單號與收據編號遞增、鎖定月拒寫、作廢留痕、重送同 token 回 `duplicate:true` 且 frequent 次數不變、list 只回當月、pnlSummary 金鑰錯回 `AUTH`、作廢不計入合計。
- **T3 auth＋admin**（`server/auth.js`）：scrypt 雜湊、等長比對、10 分 20 次鎖 10 分（依來源 IP，取 `X-Forwarded-For` 第一段）、`ADMIN_INIT` 首次寫入、adminGet/adminSave。
  驗收：測試錯 20 次後第 21 次回 `AUTH_LOCKED`；adminSave 改店長碼後舊碼 `AUTH_FAIL`；回應永不含任何通行碼。
- **T4 http＋照片＋health**（`server/index.js`、`server/health.js`）：路由、CORS、8MB 上限、照片服務（token 格式不符一律 404）、READONLY 檔、health 燈號（spec §5）、access log 每筆記 action 與耗時（不記通行碼與 body）。
  驗收：`server/test/http.test.js` 起真 server 打：OPTIONS/CORS、超大 body 413→ok:false、`/cashbook/photo/../../x` 404、health 回 level。

## P2 搬家與備份
- **T5 migrate**（`server/tools/migrate.js`）：spec §8；`--dry-run`；比對報表印月別筆數/支出/收入/作廢；不一致 exit 1。
  驗收：用 `server/test/fake-gas.js`（模擬舊後端，含 Number 型髒資料）跑，比對全過；故意改一筆後 exit 1。
- **T6 backup**（`server/backup.js`、`gas-backup/Code.js`、`gas-backup/appsscript.json`）：spec §4；GAS 照抄 `~/mala-purchase/gas/Code.js` 的金鑰比對與 setup 寫法。
  驗收：測試攔截 payload：不含 `pass`/雜湊字樣、照片成功才標 backed、失敗不覆蓋上次成功時間；GAS 端 `node` 跑純函式測試（表頭與列數）。
- **T7 舊 Apps Script**（`apps-script/Code.gs`）：`FROZEN=1` 寫入回 `MOVED`；`importRows`（ROLLBACK_KEY）以單號 upsert。不改既有任何動作的行為。
  驗收：`node test/gas-*.test.js` 既有單元測試全綠＋新增 FROZEN 與 importRows 測試。

## P3 前端
- **T8**：`js/config.js` 改 `GAS_URL`（實際網址在部署時填，先以佔位 + 註解）、設定頁、`MOVED` 文案、`sw.js` VERSION 加一。
  驗收：`node test/logic.test.js` 綠；e2e 加設定頁（改科目後記帳頁出現新科目）。
- **T9 e2e cloud 模式**：`e2e/run.py` 加一輪：起本機 Node server（暫存 DATA_DIR）、前端以 `?api=http://127.0.0.1:<port>/cashbook/api` 走真 HTTP。
  驗收：兩引擎、三個種子全綠。

## P4 部署
- **T10**：`server/launchd/com.mala.cashbook.plist`、`com.mala.cashbook.backup.plist`、`server/DEPLOY.md`、`server/CUTOVER.md`、`server/ROLLBACK.md`、`server/DEPLOY-prompt.txt`。照抄貨單／佈告欄附錄 A 路線；Funnel 用 `tailscale funnel --set-path /cashbook`。
- **T11**：`~/mala-fortune/tools/gas-watchdog/Code.js` 加 `cashbookCore_`（照 `bulletinCore_`），離線測試。
