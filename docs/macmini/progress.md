# 進度：現金收支登記｜後端搬到 Mac mini
- 開案日：2026-10-04
- 分級：完整
- 分級依據：排程=是 發訊息=否 外部後台=是 被看到=是 寫正式資料=是
- 現在在：④（①｜②｜③-需求｜③-規格｜③-方案｜④｜⑤｜結案）
- 等 Eason：①備份專案 setup()＋BACKUP_KEY ②舊專案 ROLLBACK_KEY ③在 Mac mini 貼 server/DEPLOY-prompt.txt 部署 ④挑切換時段

## ① 查（2026-10-04）
- 既有系統：mala-cashbook（skill 同名），後端 GAS @11、帳號 madesiaosinla、試算表 10TS7SY2…
- 先例一：dzy-bulletin（2026-09-30 搬 Mac mini；Node24＋node:sqlite、埠 8793、Funnel 根路徑、每小時鏡像回試算表、11 步切換 server/CUTOVER.md、回退 server/ROLLBACK.md）
- 先例二：dzy-purchase（2026-10-04；埠 8794、Funnel /purchase、每日 03:40 整頁覆蓋備份到 dingzhaoyuan5678 的 Apps Script，clasp -u dzy）
- 下游：mala-pnl-auto 的 cashbook 連接器 POST {action:'pnlSummary', key, month} 到現金帳後端（gas/connectors.js）
- 這台 Mac 沒有 tailscale／ssh 到 mini；部署照先例由 Eason 在 Mac mini 開 Claude 貼 DEPLOY prompt

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-10-04 | 階段關 | P1 伺服器核心＋T7 | 不通過（擋關 1：server/.env 未忽略） | 1 | #3 |
| 2026-10-04 | 階段關 | P1 伺服器核心＋T7 | 通過（1～8 已驗證；10 接受風險待部署實測） | 2 | #3 |
| 2026-10-04 | 階段關 | P2 搬帳＋備份 | 通過（擋關 0；應修 3 條搬帳前修） | 1 | #4 |
| 2026-10-04 | 階段關 | P2 搬帳＋備份 | 通過（應修已驗證；#4-3 再修、#4-8 改回 drive） | 2 | #4 |
| 2026-10-04 | 階段關 | P3 前端 | 通過（擋關 0；應修 4） | 1 | #5 |
| 2026-10-04 | 階段關 | P3 前端 | 通過（應修全驗證；建議收尾於 eb79d73） | 2 | #5 |
| 2026-10-04 | 階段關 | P4 部署文件＋守門 | 不通過（擋關 0；應修 5，文件／上線順序） | 1 | #6 |
| 2026-10-04 | 階段關 | P4 部署文件＋守門 | 通過 | 2 | #6 |
| 2026-10-04 | 上線 | 舊 Apps Script @12（FROZEN 未開） | 瀏覽器實測兩次 importRows 無金鑰回 AUTH、錯碼 bootstrap 回 AUTH_FAIL | 1 | 對話 |

## 落地清單
- [ ] 1 排程上線：備份 LaunchDaemon com.mala.cashbook.backup 03:50——待 Mac mini 部署
- [ ] 2 掛進監看：cashbookCore_＋艦隊格已寫好（mala-fortune 分支 watchdog-cashbook），待 CUTOVER 0-9 上線
- [ ] 3 納入故障追蹤：切換後把 /cashbook/health 與備份 log 加進累犯摘要來源清單
- [x] 4 登錄資源：dispatch-resources 現金帳列改 @12、新增「現金收支備份 Apps Script」列（切換後補 Mac mini 實際狀態）
- [x] 5 建 skill 並登錄路由：沿用 mala-cashbook skill，加「後端搬 Mac mini」一節；CLAUDE.md 路由加關鍵詞（切換後要整份改寫成 Mac mini 版）
- [x] 6 寫一則記憶：memory/mala-cashbook-macmini.md
- [x] 7 進版控：mala-cashbook 分支 macmini-backend、mala-fortune 分支 watchdog-cashbook、~/.claude f5d6b1d
- [x] 8 回報未完成與等待事項：2026-10-04 對話回報
