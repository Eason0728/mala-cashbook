# 需求：現金收支登記｜後端搬到 Mac mini
版本：v1 / 2026-10-04（待 Eason 確認）

## 1. 要解決的問題
現金帳後端跑在 Google Apps Script，平台本身慢且不穩：2026-09-25 實測 19 次有 5 次（26%）等超過 20 秒，
其中 4 次最後拿到 Google 錯誤頁。程式內部只花 1.6～3.1 秒，其餘全是平台開銷——改程式救不了，只能換平台。
9/24 深夜還因為逾時重按記出三組重複帳。

## 2. 使用者
- 光復店長：手機記帳（每天數筆，一個月約 100 筆）
- 會計：電腦匯出 Excel、改科目與通行碼、月結鎖定
- Eason：維護
- 自動損益系統（程式）：每月讀當月收支合計（pnlSummary）

## 3. 核心需求（Eason 2026-10-04 拍板）
| # | 需求 | 來源 |
|---|---|---|
| R1 | 後端資料正本放公司 Mac mini（跟佈告欄、貨單共用同一台、同一個對外網址，走不同路徑） | Eason 指定 |
| R2 | 每天備份一次到 **dingzhaoyuan5678@gmail.com** 帳號底下的試算表（整頁覆蓋）；試算表**不分享** | Eason 指定、Q3=B、Q7=A |
| R3 | 收據照片存 Mac mini，每天備份到 dingzhaoyuan5678 的雲端硬碟 | Q1=A |
| R4 | app 內加「設定」頁，憑**管理通行碼**改科目、店長通行碼（取代原本改試算表「設定」分頁） | Q2=A |
| R5 | 9 月起所有歷史帳（含作廢、常用項目、月結鎖定）全部搬進 Mac mini，app 照樣查得到、匯得出 | Q6=A |
| R6 | 盡快切換（不等 11/1）。因為歷史全搬，10 月不會被切成兩半 | Q5=現在 |
| R7 | Mac mini 掛掉時：接受停機；舊 Apps Script 保留**唯讀**，緊急時把前端網址切回去 | Q4=A |
| R8 | 速度標準：登入、記一筆一般 1 秒內完成；不再出現 20 秒以上的等待 | Q8 照建議 |
| R9 | 店長看到的畫面、操作流程、匯出 Excel 格式**全部不變**（唯一新增＝設定頁） | 既有設計決定 |
| R10 | 既有防重複機制全部保留：逾時後先查再說、同一次送出只記一筆（clientToken）、唯讀才自動重送 | 既有設計決定 |
| R11 | 自動損益系統讀現金帳合計的那條路（pnlSummary）改接 Mac mini，金鑰照舊獨立 | 下游依賴 |

## 4. 我替你預設的（確認時有意見再改）
- **照片連結**：Excel 裡的照片連結改成 Mac mini 上一條「猜不到的網址」（每張照片一串隨機碼），
  有連結的人點得開、沒連結的人找不到——跟 Google 雲端「知道連結的人可檢視」同一個等級。
  現況其實更差：舊照片只有 madesiaosinla 本人打得開，會計點了是無權限。
- **舊照片不搬**：9 月以來的舊照片留在 madesiaosinla 雲端硬碟，連結照舊；只有切換後拍的新照片放 Mac mini。
- **管理通行碼**：跟店長通行碼分開，初始值由你在 Mac mini 的設定檔填（不進 GitHub）。
- **切換當下會有約 10～20 分鐘不能記帳**（凍結舊系統 → 搬資料 → 比對 → 切網址）。挑店長沒在記帳的時段，前一刻在群組講一聲由你發（我不發群組訊息）。
- **舊試算表**：切換後凍結成唯讀、不刪，當歷史存證與回退用。

## 5. 不做的事
- 不改店長的記帳流程與畫面（除了設定頁）
- 不做多店（仍只有新竹光復）
- 不做離線暫存（Q4 選 A）

## 6. 探到的事實
| 探什麼 | 指令 | 實際輸出 | 結論 | 對設計的影響 |
|---|---|---|---|---|
| 身分與權限：這台 Mac 能否直接操作 Mac mini | `which tailscale; tailscale status`；`grep Host ~/.ssh/config` | `tailscale not found`；無 ssh 設定 | 這台連不到 mini | 部署照先例：寫 DEPLOY.md＋一段 prompt，Eason 在 mini 上開 Claude 執行 |
| 身分與權限：Mac mini 上 LaunchDaemon 身分讀寫資料夾 | 未實測（連不到 mini） | 未確認 | 先例（佈告欄、貨單）同一台、同一身分已跑通 | 部署第 0 步在 mini 上實測，寫入 `~/mala-cashbook-data` |
| 身分與權限：dingzhaoyuan5678 的 clasp 登入 | dispatch-resources「進貨金額備份」列 | 2026-10-04 已用 `clasp -u dzy` 建專案並部署 @1 | 帳號可用 | 備份 Apps Script 用同一個 `-u dzy` 建新專案 |
| 身分與權限：讀舊試算表 | Drive 連接器 get_file_metadata `10TS7SY2…` | `Requested entity was not found` | 連接器是別的帳號，讀不到 | 搬資料改走舊後端自己的 API（帶店長通行碼逐月 `list`），在 mini 上跑 |
| 資料真面目：欄位 | `sed -n 1,23p apps-script/Code.gs` | 明細 17 欄：單號…作廢原因；另有設定／常用項目（4 欄）／月結（3 欄） | 結構小、固定 | SQLite 四張表一比一對應 |
| 資料真面目：量與髒資料 | `private/paper-2026-09.real.js`；skill 紀錄 | 9 月紙本約 30 筆量級；試算表曾回 Number 型名稱「1234」、空值 | 量極小；型別不可信 | 搬資料時一律轉字串＋e2e 照樣灌髒資料 |
| 執行環境 | 佈告欄 `server/DEPLOY.md` 附錄 A、記憶 | Node 24 內建 sqlite、LaunchDaemon、FileVault 開著＝停電要人到場解鎖 | 可無人自跑；停電要人 | Q4 已接受；/health 掛排程守門 |
| 額度與花錢 | 先例 | Tailscale Funnel 現用免費；Apps Script 每天一次 doPost 遠低於額度 | 0 元 | 無 |
| 下游：損益系統 | `grep cashbook ~/mala-pnl-auto/gas/connectors.js` | POST `{action:'pnlSummary', key, month}` | 換網址＋金鑰搬到 mini | 切換步驟要含改損益連接器網址並實打一次 |
| 下游：會計 Excel | skill 紀錄 | 2026-09-09 起瀏覽器就地產檔，不打後端 | 不受影響 | 照片連結欄改 mini 網址 |
| 下游：同一個 Funnel | 貨單 DEPLOY.md | 改 Funnel 必須用 `tailscale funnel --set-path`，用 `serve` 會關掉對外 443 | 新增 `/cashbook` 路徑不能動到 `/` 與 `/purchase` | 部署步驟照抄並驗另外兩套仍通 |
