# 規格：現金收支登記｜後端搬到 Mac mini
版本：v1 / 2026-10-04（待 Eason 確認；需求見 requirements.md v1，2026-10-04 已確認）

## 1. 架構
```
店長手機／會計電腦（前端不變：eason0728.github.io/mala-cashbook）
   ▼ POST text/plain JSON（契約跟現在一模一樣）
Tailscale Funnel  https://<mini>.ts.net/cashbook/…      ← 跟佈告欄（/）、貨單（/purchase）共用，只加路徑
   ▼
Mac mini  Node 24（無第三方套件）  127.0.0.1:8795
   ├─ ~/mala-cashbook-data/cashbook.db   SQLite，正本
   ├─ ~/mala-cashbook-data/photos/       收據照片
   └─ 每天 03:50 備份 ──► dingzhaoyuan5678 的 Apps Script「現金收支備份」
                           ├─ 試算表（整頁覆蓋，不分享）
                           └─ 雲端硬碟資料夾（只補傳還沒備份過的照片）
舊 Apps Script（madesiaosinla）→ 凍結成唯讀，留作存證與回退
自動損益系統 ──pnlSummary──► 改打 Mac mini
```
程式放在既有 repo `~/mala-cashbook/server/`（public，程式不含任何祕密）；
祕密只放 mini 上的 `server/.env`（gitignore）。部署目錄 mini 上 `~/mala-cashbook`，資料 `~/mala-cashbook-data`。

## 2. 對外端點
| 路徑 | 用途 |
|---|---|
| `POST /cashbook/api` | 所有動作，body＝`{action, pass, …}`，回 `{ok:true,…}`／`{ok:false,error}` |
| `GET /cashbook/photo/<32 位隨機碼>.jpg` | 收據照片（猜不到的網址＝知道連結才看得到） |
| `GET /cashbook/health` | 健康燈號 `{level:'green|yellow|red', reasons:[…], backupAt, rows, diskFreeGB}`，不含任何帳目 |
| 其他 | 404 |

CORS 只允許 `https://eason0728.github.io`（另可由 `.env` 加）。body 上限 8 MB（照片 base64）。

### 2.1 動作（既有 8 個：名稱、參數、回應形狀與 Code.gs 逐字一致）
`bootstrap`、`list`、`create`、`update`、`void`、`lock`、`unlock`、`pnlSummary`（`export` 不再實作，前端 09-09 起不呼叫）。
規則照搬：splitTax、單號 `YYYY-MM-NNN`、收據編號依收支別各自遞增、鎖定月份拒寫（`LOCKED`）、作廢只改狀態、
`create` 失敗照片不擋帳（回 `warning:'PHOTO_FAIL'`）、錯誤碼（`AUTH_FAIL`／`BAD_INPUT`／`LOCKED`／`NOT_FOUND`）。
**唯一行為差異**：`clientToken` 改存資料表、永久保存（舊版存快取 6 小時、快取失效會退回記兩筆）。

### 2.2 新增動作（設定頁用）
| 動作 | 參數 | 說明 |
|---|---|---|
| `adminGet` | `adminPass` | 回科目清單、店別（不回任何通行碼） |
| `adminSave` | `adminPass`, `expenseSubjects`, `incomeSubjects`, `newStorePass?`, `newAdminPass?` | 改科目／店長通行碼／管理通行碼；通行碼至少 4 碼 |

### 2.3 安全
- 通行碼只存雜湊（scrypt＋鹽），不存明碼；管理通行碼初始值來自 `.env` 的 `ADMIN_INIT`（只在資料庫還沒有時寫入一次）。
- 通行碼錯：同一來源 10 分鐘錯 20 次 → 鎖 10 分鐘（照貨單）。比對用等長逐字元。
- `pnlSummary` 金鑰 `PNL_KEY` 放 `.env`，與通行碼無關（照舊）。

## 3. 資料表（SQLite）
| 表 | 欄位 | 對應舊試算表 |
|---|---|---|
| `rows` | id PK, store, date, kind, subject, name, amount, has_invoice, net, tax, seq, photo（網址）, author, created_at, status, voided_at, void_reason, photo_file, photo_backed_at | 明細 17 欄＋2 欄照片管理 |
| `frequent` | subject, name, count, last_used（PK subject+name） | 常用項目 |
| `locks` | month PK, status, locked_at | 月結 |
| `settings` | key PK, value | 設定（店別、科目、通行碼雜湊） |
| `create_tokens` | token PK, row_id, created_at | 新：冪等 |
| `meta` | key PK, value | 新：遷移時間、上次備份結果 |

寫入一律包在一個 transaction 裡；Node 單一行程依序處理寫入，取代舊版的 LockService。
每天備份前另存一份資料庫檔快照到 `~/mala-cashbook-data/snapshots/`，保留 14 天。

## 4. 備份（每天 03:50，LaunchDaemon `com.mala.cashbook.backup`）
1. 資料：POST 到 dzy 帳號的備份 Apps Script `{action:'backup', key, rows, frequent, locks, subjects}`，
   試算表分頁「明細」「常用項目」「月結」「科目」**整頁清空重寫**（跑兩次結果相同）。**不送任何通行碼。**
2. 照片：`photo_backed_at` 為空的照片逐張 POST `{action:'photo', key, name, base64}` 存進 Apps Script 建的資料夾，成功才記時間。單次最多 50 張，剩下的明天繼續。
3. 結果寫 `meta`，失敗不覆蓋上次成功時間。
4. 備份 Apps Script：新專案（`clasp -u dzy`），`setup()` 建試算表＋資料夾、ID 存指令碼屬性；金鑰 `BACKUP_KEY` 由 Eason 自己設；不分享。

## 5. 健康燈號與監看
- 紅：上次成功備份超過 26 小時、資料庫打不開、磁碟剩不到 2 GB
- 黃：照片待備份超過 200 張、最近一次備份失敗但上一次成功還在 26 小時內
- 排程守門 `schedule-watchdog` 加一支 `cashbookCore_`（照抄 `bulletinCore_`，跟 07:30／09:30／10:30 三班跑），紅燈寄信；指揮台艦隊加一格「現金帳伺服器」。

## 6. 前端改動（只有這些）
1. `js/config.js`：`GAS_URL` 改成 Funnel `/cashbook/api`（主機名跟佈告欄、貨單同一個，已在公開 repo，不增加曝光）。
2. 新增「設定」頁（會計用）：輸入管理通行碼 → 改科目、改店長通行碼、改管理通行碼。
3. 舊後端回 `MOVED` 時顯示「系統已更新，請把 app 完全關掉再打開」。
4. `sw.js` 的 `VERSION` 加一。
（照片連結、匯出格式、防重複機制都不用動前端：照片網址由後端回傳。）

## 7. 舊 Apps Script 的改動（只加不改）
- 指令碼屬性 `FROZEN=1` 時：寫入動作（create／update／void／lock／unlock）一律回 `MOVED`；讀取照常。
- 新增 `importRows`（金鑰 `ROLLBACK_KEY`，只在回退時用）：把 Mac mini 上切換後新增／修改的帳寫回試算表。

## 8. 搬資料（`server/tools/migrate.js`，在 mini 上跑）
1. 前置：舊後端設 `FROZEN=1`（從這刻起店長記不了帳 → 切換時段開始）。
2. 用店長通行碼呼叫舊後端 `bootstrap`（設定、常用項目、月結）＋逐月 `list`（2026-09 到本月）。
3. 寫進 SQLite：單號、收據編號、登記時間、作廢狀態、舊照片網址**原樣保留**；所有值一律轉字串再轉型（試算表會回 Number）。
4. 比對：每個月的筆數、支出合計、收入合計、作廢筆數，舊新兩邊完全相同才算過；不同就停，不切網址。
5. `--dry-run` 只讀不寫，先跑一次量時間。

## 9. 切換步驟（摘要；細節寫進 `server/CUTOVER.md`）
0. Mac mini 部署完、`/cashbook/health` 綠、佈告欄與貨單仍正常（驗 Funnel 沒被動到）
1. Eason 在群組通知店長（Eason 自己發）
2. 舊後端 `FROZEN=1` → 3. `migrate.js` 正式跑＋比對全過
4. 前端 push 新 `config.js`＋`sw.js` → 5. 實測：登入、記一筆、作廢、匯出、拍照、`pnlSummary`
6. 改自動損益系統的現金帳連接器網址並實打一次 → 7. 隔天確認 03:50 備份成功、試算表有資料
**回退**：mini 寫入凍結 → `importRows` 把切換後的帳寫回舊試算表 → 舊後端 `FROZEN` 拿掉 → 前端網址改回 → 損益連接器改回。

## 10. 速度驗收（R8）
- 伺服器端每個動作 p95 < 200 毫秒；手機端登入、記一筆（不含照片）中位數 < 1 秒
- 切換後連續 3 天，前端沒有任何一次 20 秒逾時（查 mini 的 access log：每筆記耗時）

## 11. 測試
- 既有 `node test/logic.test.js`、`e2e/run.py`（local 模式）照跑全綠
- 新增 `server/test/`：每個動作的行為與 Code.gs 對照（同一組輸入、回應形狀一致）、冪等、鎖定、通行碼鎖、備份 payload 不含通行碼、遷移比對
- e2e 加一輪「cloud 模式打本機 server」：前端真的走 HTTP 打 Node 後端，補上以前只有 local 才測得到的缺口
