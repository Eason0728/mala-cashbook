# 技術方案：現金收支登記｜後端搬到 Mac mini
版本：v1 / 2026-10-04（spec v1 已於 2026-10-04 確認）

## 共用契約（所有任務都照這份，逐字）
- 伺服器目錄：`server/`；進入點 `server/index.js`；Node 24 內建模組，**不准裝第三方套件**（`node:sqlite`、`node:http`、`node:crypto`、`node:test`）。
- 設定 `server/config.js` 讀 `server/.env`（gitignore）＋環境變數，欄位：
  `PORT`(預設 8795) `BIND`(127.0.0.1) `DATA_DIR`(預設 `~/mala-cashbook-data`) `ADMIN_INIT` `PNL_KEY` `BACKUP_URL` `BACKUP_KEY` `ALLOW_ORIGIN`(逗號分隔，預設 `https://eason0728.github.io`) `PUBLIC_BASE`(照片網址前綴，例 `https://x.ts.net/cashbook`)
- URL 前綴固定 `/cashbook`：`POST /cashbook/api`、`GET /cashbook/photo/<token>.jpg`、`GET /cashbook/health`。
- 照片 token：`crypto.randomBytes(16).toString('hex')`（32 個小寫十六進位字元），檔名 `<token>.jpg`，照片網址 `PUBLIC_BASE + '/photo/' + token + '.jpg'`。
- 時間字串格式與舊版相同：`YYYY-MM-DDTHH:mm:ss+08:00`（台北時區）。
- 單號：`YYYY-MM-NNN`（NNN＝該月既有筆數＋1，三位補零）；收據編號 seq＝該月同收支別最大 seq＋1。
- 錯誤回應：`{ok:false, error:'<CODE>'}`，HTTP 一律 200（前端照舊判 ok）。新碼：`AUTH_LOCKED`、`MOVED`、`READONLY`。
- 資料目錄有 `READONLY` 這個檔存在時，所有寫入回 `READONLY`（回退用）。
- 備份 payload：`{action:'backup', key, rows:[[17 欄表頭...],...], frequent:[...], locks:[...], subjects:{expense:[], income:[]}}`；照片 `{action:'photo', key, name:'<id>_<token>.jpg', base64}`。

## 階段
| Phase | 內容 | 里程碑（可驗收） |
|---|---|---|
| P1 伺服器核心 | T1 db＋config、T2 八個動作、T3 auth＋admin、T4 http＋照片＋health | `node --test server/test` 全綠；同一組輸入對照 Code.gs 行為一致 |
| P2 搬家與備份 | T5 migrate.js、T6 backup.js＋備份 Apps Script、T7 舊 Apps Script FROZEN＋importRows | 用假舊後端跑 migrate 比對全過；備份 payload 不含通行碼 |
| P3 前端 | T8 設定頁＋MOVED＋config＋sw、T9 e2e cloud 模式打本機 server | 既有 162 項＋新增項 兩引擎全綠，三個種子 |
| P4 部署文件與監看 | T10 launchd＋DEPLOY/CUTOVER/ROLLBACK＋prompt、T11 守門 cashbookCore_ | 文件可照著做；守門離線測試綠 |

每個 Phase 結束開一個 GitHub issue 跑 Fable 階段關，過了才進下一個。
