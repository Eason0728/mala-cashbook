# 切換手冊：Apps Script → Mac mini（現金收支登記，T10）

把現行後端（madesiaosinla 帳號的 Apps Script＋試算表）切換到 Mac mini。順序固定，不可調換。照 `docs/macmini/spec.md` §9，嚴謹度照 `~/dzy-bulletin/server/CUTOVER.md`。

每一步都標了三件事：**負責人、驗證方式、失敗時怎麼辦**。回退一律照 [`ROLLBACK.md`](ROLLBACK.md)；部署照 [`DEPLOY.md`](DEPLOY.md)。

角色：

- **Eason**：群組通知、舊 Apps Script 指令碼屬性、舊／備份 Apps Script 的部署、手機與電腦實測、核准 push。
- **Mac mini 的 Claude**：只在 Mac mini 上跑 `server/` 的指令。
- **MacBook 的 Claude**：前端 `js/config.js`、`sw.js`、push、損益系統連接器的網址由 Eason 在瀏覽器改。

硬規則：

- **Claude 絕不經手任何通行碼與金鑰**：店長通行碼（`OLD_PASS`）、`BACKUP_KEY`、`ROLLBACK_KEY`、`PNL_KEY`、`ADMIN_INIT` 一律由 Eason 在自己的終端機或瀏覽器輸入，不印出、不貼對話、不寫檔。
- **Funnel 主機名只出現在兩個地方**：切換那個 commit 的 `js/config.js`（前端本來就得知道它，repo 是公開的，這無法避免）與 Mac mini 的 `server/.env`（不進 git）。不貼進 issue、PR、留言、手冊；量測時放在 shell 變數。
- 舊 Apps Script 的網址等同鑰匙（前端 `js/config.js` 現有那串），也不貼進 issue 或留言。
- **不要用 `curl` 測 Apps Script 的 `doPost`**：`/exec` 會 302 轉到只收 GET 的網址，`curl -X POST` 轉址後仍是 POST 會拿到錯誤頁；要測就在瀏覽器用 `fetch`（第 3 步附範例）。

以下 Mac mini 指令都**每一段前先貼這一行**（Claude 每次 Bash 呼叫是新的 shell）：

```sh
cd ~/mala-cashbook; export PATH="$HOME/.local/node/bin:$PATH"; NODE="$HOME/.local/node/bin/node"; DATA="$HOME/mala-cashbook-data"; command -v node   # 要印出 …/.local/node/bin/node
```

---

## 0. 前置檢查（切換日前一天完成）

| # | 項目 | 負責人 | 怎麼確認 |
|---|---|---|---|
| 0-1 | Mac mini 部署完成（`DEPLOY.md` 第 0～8 步全過，含重開機測試），`deploy-evidence.txt` 有每一步的紀錄 | Mac mini 的 Claude | `curl -s http://127.0.0.1:8795/cashbook/health` 回 `"level":"green"`；手機 4G 打 `https://<funnel 主機>/cashbook/health` 也通；佈告欄 `/health` 與貨單 `/purchase/api/health` 仍正常（驗 Funnel 沒被動到） |
| 0-2 | 備份 Apps Script（dingzhaoyuan5678 帳號）已部署、**Eason 已跑過 `setup()` 並授權**、指令碼屬性 `BACKUP_KEY` 已設，與 Mac mini `.env` 同一把 | Eason | `DEPLOY.md` 第 3 步 B1 已做；`DEPLOY.md` 第 8-1 手動備份結束碼 `0` |
| 0-3 | **舊 Apps Script 已部署含 `FROZEN`／`importRows` 的新版**（`apps-script/Code.gs`，T7），且指令碼屬性已設 **`ROLLBACK_KEY`**（Eason 自產；`openssl rand -hex 32`，同時存進 Eason 自己的密碼管理器，回退時要用）。**這一步只部署程式與設金鑰，還不設 `FROZEN`** | Eason（MacBook 的 Claude 協助 `clasp push`／`deploy`，用**同一個部署 ID**，網址才不會換） | 部署後在店長手機用現行前端記一筆再作廢（確認新版沒弄壞既有功能）；Apps Script 指令碼屬性看得到 `ROLLBACK_KEY`（值不給 Claude 看）；**`FROZEN` 此刻不存在** |
| 0-4 | （無前置）**部署不先併 main**：Mac mini 從分支 `macmini-backend` 部署，`main` 此時沒有 `server/` 與 `MOVED` 文案。凍結（第 3 步）到前端切換（第 5 步）之間，舊版前端遇到 `MOVED` 只會顯示一般錯誤——這段本來就是停機時段，可接受（第 1 步通知已先告知） | — | 第 5 步才把 `macmini-backend` 併進 `main` |
| 0-5 | 目標資料庫是空的（部署後沒人寫過） | Mac mini 的 Claude | `"$NODE" -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/cashbook.db',{readOnly:true});console.log('rows',d.prepare('SELECT COUNT(*) n FROM rows').get().n)" "$DATA"` 要印 `rows 0`；`ls "$DATA/READONLY"` 要回「No such file」 |
| 0-6 | 記下切換前的 `js/config.js` 的 `GAS_URL`（舊網址）與 `sw.js` 的 `VERSION`，**回退時要用**；並把舊 Apps Script 的**部署 ID／版本號**記下 | MacBook 的 Claude → 交給 Eason 存到自己的密碼管理器（舊網址是鑰匙，不貼 issue） | `git -C ~/mala-cashbook show HEAD:js/config.js` 有那一行；git 歷史本身也留著，回退時用 `git show <切換前 commit>:js/config.js` 取 |
| 0-7 | 在 Mac mini 上以舊網址 `--dry-run` 量時間（只讀不寫，隨時可跑；通行碼由 Eason 自己輸入） | Eason 輸入通行碼、Mac mini 的 Claude 跑 | 照第 4 步的 dry-run 區塊，**提前一天先跑一次**，確認筆數合理、耗時、沒有「中止」訊息；預估正式搬遷耗時＝dry-run 耗時 + 寫入（通常 < 1 分鐘）。耗時決定第 1 步通知店長的時段長度 |
| 0-8 | 現行資料沒有髒資料會讓 migrate 中止（`BAD_TS`、金額不合法、重複單號） | Mac mini 的 Claude | 0-7 的 dry-run 沒印「中止」；有的話（時間欄解析不了、單號重複）**先在舊試算表修好**再重跑 dry-run，不要帶到切換窗口裡才發現 |

### 0-9 守門上線（**切換前**做；`config.js` 仍指 script.google.com，守門判「略過」並計入正常，不會誤報）

**負責人**：MacBook 的 Claude（Eason 在場核准、並在 Apps Script 編輯器按執行）。**①→④ 同一天內做完**——艦隊格先上線、守門還沒寫過 run，指揮台會判「守門還沒寫過結果」而每天誤報斷線，直到第一筆 run 出現。

1. 把 `Eason0728/mala-fortune` 的分支 `watchdog-cashbook` **合併進 main**（`cashbook_health.yml`＋`command-deck/contracts.py`＋`rank.py` 同一包；yml 不在 main，守門的 `dispatch_` 會 404）。
2. 把守門程式推上雲端：`cd ~/mala-gas/schedule-watchdog`，先照 `grep "排程守門" ~/.claude/mala-ops/dispatch-resources.md` 那一列確認它與 `~/mala-fortune/tools/gas-watchdog/Code.js`（版控正本）的同步方式，以**整檔複製**同步（`cp ~/mala-fortune/tools/gas-watchdog/Code.js ~/mala-gas/schedule-watchdog/Code.js`；複製前先 `git -C ~/mala-gas status` 看該檔有沒有未提交的改動，有就停下來問 Eason）後 `clasp push -u eason`（個人帳號 a0953668824）。
3. **立刻**在 Apps Script 編輯器（Chrome 從 `script.google.com/u/1/home` 清單點進專案）手動執行 `cashbookWatch()` 一次（會送出判為 `skip` 的 run）。
4. `gh run list --repo Eason0728/mala-fortune --workflow cashbook_health.yml` 要看到 **1 筆成功 run**才算完成；指揮台艦隊「現金帳伺服器」那格轉為正常。

**失敗怎麼辦**：`dispatch_` 回 404 → 第 1 步沒合併；沒有 run → 看編輯器「執行紀錄」；艦隊格斷線 → 第 3 步沒跑，補跑即可。守門不影響記帳，也不擋切換。

**失敗怎麼辦**：0-1～0-3 任何一項不過，**不進第 1 步**；這些都還沒影響店長，慢慢修。0-8 發現的髒資料由 Eason 在舊試算表修（修之前先複製試算表當備份）。

---

## 1. Eason 在群組通知店長（Claude **不發**）

**負責人**：Eason

搬家前約 30 分鐘在店長群組發（時段依 0-7 的耗時加 15 分鐘餘裕；選離峰、**店裡不營業或最不忙的時間**）：

> 【現金帳搬家通知】
> 今天 ○○:○○～○○:○○ 現金收支登記要搬到新主機，這段時間**暫時不能記帳**，請先用紙本或手機備忘錄記，搬完再補登。
> 畫面若出現錯誤訊息或記不進去是正常的，先別重按。
> ○○:○○ 之後請把 app 關掉再重新打開，**不用換通行碼**，之前記的帳都在。

搬家完成（第 6 步全過）後 Eason 再發：

> 【現金帳搬家完成】
> 現金收支登記已經搬好了，請把 app 完全關掉再重新打開一次就能正常使用，通行碼不變。如果畫面還顯示「系統已更新…」，請等 10 分鐘再重開。

需要回退時發（ROLLBACK.md）：

> 【現金帳暫時換回舊系統】
> 現金收支登記暫時換回原本的系統，請把 app 完全關掉再重新打開，通行碼不變，之前記的帳都在。

**預期行為（不是故障）**：從凍結（第 3 步）到前端新 `config.js` 生效（第 5 步），中間含搬遷時間再加 Pages 快取約 30～60 秒到 10 分鐘；這段時間**寫入一律失敗（回 `MOVED`）、讀取照常**；舊版前端（`main` 尚未更新）遇 `MOVED` 只顯示一般錯誤，不會提示重開 app，這段是停機時段，可接受。

---

## 2. 確認店長此刻沒有「正在送出」

**負責人**：Eason（問店長）＋Mac mini 的 Claude

**為什麼**：舊後端用 `clientToken` 防止逾時重送記兩筆；這份 token 只活在舊後端的快取（6 小時），**搬遷不會把它帶過來**。如果店長在凍結前剛好有一筆「按了送出、畫面轉圈、逾時」的紀錄，凍結後她重按，舊後端回 `MOVED`，新後端則不認得這個 token——結果是**那筆可能已經記在舊試算表（會被搬過來），而店長不確定，補登一次就變兩筆**。

- [ ] Eason 在群組問店長：「**現在有沒有正在送出、轉圈圈、或剛剛顯示逾時／出錯的那一筆？** 有的話先不要按，回我。」等店長回答「沒有」。
- [ ] Eason 自己打開舊試算表「明細」分頁，看**最後幾列的登記時間**是否與店長說的一致。若店長說「剛剛有一筆逾時」，確認那一筆有沒有在試算表裡；**有的話告訴店長不用重記，沒有的話告訴店長搬完再補**。
- [ ] 店長回「沒有」、且最後一列登記時間距現在超過 1 分鐘 → 才進第 3 步。

**失敗怎麼辦**：店長不回、或說有逾時未確認的 → **不進第 3 步**，等她確認；時段超過公告範圍就改天。

---

## 3. 舊 Apps Script 凍結：指令碼屬性 `FROZEN=1`

**負責人**：**Eason 親手**（Apps Script 編輯器 → 專案設定 → 指令碼屬性）

新增 `FROZEN` = `1` → 儲存。（Apps Script 的屬性立即生效，不用重新部署。）**從這一刻起店長記不了帳＝切換時段開始。**

**驗證**（用瀏覽器 `fetch`，**不要用 curl**）：Eason 在電腦瀏覽器打開 `https://eason0728.github.io/mala-cashbook/`，按 F12 → Console，貼下面這段（會跳出輸入框要店長通行碼，**只在這裡輸入、不貼給任何人**）：

```js
(async () => {
  // 網址直接寫死：Console 不一定在 app 頁面的執行環境裡，Config 可能讀不到（2026-10-05 實際踩到 Config is not defined）
  const URL = 'https://script.google.com/macros/s/AKfycbyelA64WCKft6WhiMZJjtl1egZV3jFUt0eT_MP2KfkkBA7ry9vJEuylIaqC7p_Bk3p56w/exec';
  const pass = prompt('店長通行碼（只在這裡輸入）');
  const post = (b) => fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(b) }).then((r) => r.json());
  const c = await post({ action: 'create', pass, date: '2026-10-01', kind: '支出', subject: '雜支', name: '凍結測試', amount: 1 });
  const l = await post({ action: 'bootstrap', pass });
  console.log('create →', c.ok, c.error, '｜bootstrap（讀取）→', l.ok);
})();
```

- 期望：`create → false MOVED ｜bootstrap（讀取）→ true`。（凍結檢查在驗證通行碼之後、動工之前，所以這筆**不會**寫入試算表；仍請 Eason 回舊試算表確認沒有「凍結測試」那一列。）
- Eason 記下舊試算表「明細」分頁的**總列數與最後一列單號**，第 4 步比對要用。

**失敗怎麼辦**
- 回 `ok: true`（寫進去了）：屬性沒存成功或打到別的部署。**立刻**把剛寫的那一列在舊試算表標作廢（或刪掉那一列，是你自己測的），重新整理 Apps Script 頁面再設一次 `FROZEN`；確認 0-3 部署的是含 `FROZEN` 的新版（`clasp deployments` 版本、部署 ID 與前端用的相同）。
- 回 `AUTH_FAIL`：通行碼輸錯，重試。
- 想中止：把 `FROZEN` 刪掉，就等於什麼都沒發生。

---

## 4. 搬資料：`migrate.js`（dry-run → 正式 → 比對全過才繼續）

**負責人**：Eason 輸入通行碼，Mac mini 的 Claude 跑

`OLD_GAS_URL` 取自 Mac mini 上 repo 現有的 `js/config.js`（還沒改，就是舊網址；寫進 shell 變數、**不印出**），`OLD_PASS` 由 **Eason 在自己的終端機 App** 輸入（不回顯）。所以這一步 Claude 把指令貼給 Eason，Eason 在他的終端機跑，只把輸出（筆數與比對表，不含網址與通行碼）貼回給 Claude。

```sh
cd ~/mala-cashbook; export PATH="$HOME/.local/node/bin:$PATH"
git pull --ff-only                                          # 確認程式是最新（此時 js/config.js 仍是舊網址）
export OLD_GAS_URL="$(sed -n "s/^ *GAS_URL: '\([^']*\)'.*/\1/p" js/config.js)"
read -rs "OLD_PASS?舊店長通行碼（不回顯）："; echo; export OLD_PASS
node server/tools/migrate.js --dry-run                      # ① 只讀不寫
```

- dry-run 印出：舊端各月統計（筆數、支出、收入、作廢）、時間欄樣本、預估寫入筆數、耗時。確認數字與 Eason 第 3 步記的舊試算表總列數相符。
- 有「中止」訊息（重複單號、時間無法解析、金額不合法）→ 見下方失敗表，**先不進正式搬遷**。

dry-run 沒問題就正式跑：

```sh
node server/tools/migrate.js; echo "exit=$?"                # ② 正式：一個 transaction 寫入，然後逐筆逐欄比對
```

- 輸出要有每月的比對表（舊筆數／新筆數、支出、收入、作廢全部 `OK`）、`逐筆比對：N 筆 × 17 欄、frequent、locks、科目、店別，全部相同`、最後一行 **`比對全過`**，且 **exit=0**。
- 搬遷同時：沿用同一組店長通行碼（只存雜湊）、寫入 `meta.migrated_at`（遷移時間，回退時 `rollback-export.js` 用它判斷哪些是切換後新增的）。
- 結束後**立刻清掉通行碼**：`unset OLD_PASS OLD_GAS_URL`，並清空終端機視窗與捲動紀錄（⌘K）。
- 再獨立驗一次（唯讀、不寫）：`node server/tools/migrate.js --verify-only` 也要 `比對全過`（重新打一次舊後端；需要重新設 `OLD_PASS`，用上面同樣的 `read -rs`）。

**失敗怎麼辦**（前端還沒動，任何失敗都可以安全中止：**Eason 把舊 Apps Script 的 `FROZEN` 刪掉，店長就恢復正常，等於什麼都沒發生**）

| 狀況 | exit | 怎麼辦 |
|---|---|---|
| 「中止：舊端有重複單號」或「有資料無法安全搬入」 | 1 | 不寫入。把印出的單號交給 Eason，**在舊試算表修好**（重複單號：由 Eason 判斷留哪一列；時間欄／金額壞掉：改成正確值）。修好前要不要先解除 `FROZEN` 讓店長記帳，由 Eason 依修的時間定；之後從第 2 步重來。 |
| 「呼叫舊後端失敗（重試 3 次）」 | 1 | 舊後端暫時不通（Google 暫時錯誤、網路）。等 1～2 分鐘重跑。連續失敗 → 解除 `FROZEN` 中止，改天。 |
| 「舊後端回報：AUTH_FAIL」 | 1 | 通行碼打錯。Eason 重新輸入再跑（注意：通行碼連錯多次，舊後端可能暫時鎖定，等 10 分鐘）。 |
| 「拒絕：目標資料庫 rows 已有 N 筆」 | 2 | 0-5 沒做好，或上次搬到一半。先弄清楚那是什麼資料；確定可以覆蓋才加 `--replace`（會先清 rows／frequent／locks／防重送紀錄），**不要在已經有人在 Mac mini 記過帳之後加 `--replace`**。 |
| 比對表有「不一致」或「逐筆比對：N 項差異」 | 1 | **不要切換前端**。把整段輸出（只含筆數與單號，不含通行碼）貼給 MacBook 的 Claude 查。資料已寫進新庫但沒人在用，查明原因後加 `--replace` 重跑。查不出來或超過 Eason 能接受的時段 → **解除 `FROZEN` 中止**。 |
| 「警告：N 筆的科目或名稱超過 100 字」 | 0 | 不影響搬遷（照搬），只是之後在新系統**改**那幾筆時需重填過長欄位。記下單號，通知會計。 |

**切換窗口判斷點**：從第 3 步設下 `FROZEN` 起算，**預計 20 分鐘內搬不完或比對不過，就中止**（Eason 刪 `FROZEN`，群組說「搬家延後」），不要拖成長停機。

---

## 5. MacBook 端 Claude：把 `macmini-backend` 合併進 main，並改 `GAS_URL`（一次做完）

**負責人**：MacBook 的 Claude（Eason 核准 push）。**Funnel 主機名由 Eason 在對話裡給**（`DEPLOY.md` 第 6 步 Mac mini 的 Claude 當時交給他的）。

**合併與改網址在同一次 push 完成**（避免店員在切換前先看到設定頁入口）。合併後 Mac mini 的更新改從 `main` pull。**只改這幾處**：

| 檔案 | 改成 |
|---|---|
| `js/config.js` | `GAS_URL: 'https://<funnel 主機>/cashbook/api'`（結尾是 `/cashbook/api`，不是 `/exec`）。**網址只出現在這個 commit 裡，不貼進 issue 或留言。** 舊網址那段註解一併改成「2026-10-xx 起後端在 Mac mini；舊 Apps Script 已凍結（FROZEN），回退見 server/ROLLBACK.md」，**不要把舊網址留在註解裡** |
| `sw.js` | `VERSION` 加一（舊快取會在啟用時全部清掉） |

```sh
cd ~/mala-cashbook && git checkout main && git pull --ff-only && git merge macmini-backend    # 後端程式、文件、設定頁、MOVED 文案一併進 main（此前刻意不併）
# 編輯 js/config.js、sw.js 如上表
node test/logic.test.js                                                            # 既有單元測試要全綠
git add js/config.js sw.js && git commit -m "切換：前端改指 Mac mini 後端" && git push origin main
```

**驗證**（GitHub Pages 約 30～60 秒；檢查**公開頁面實際載入的那一份**，不要加 `?v=` 繞過快取）：

```sh
curl -s https://eason0728.github.io/mala-cashbook/js/config.js | grep -c "script.google.com"     # 要回 0（已不再指向舊 Apps Script）
curl -s https://eason0728.github.io/mala-cashbook/sw.js | grep "VERSION ="                        # 新版本號
```

- Mac mini 的 Claude 同時 `tail -f "$DATA/logs/server.log"`，要出現 `api:bootstrap ok …ms`（從店長手機或 Eason 的瀏覽器打來的）。

**失敗怎麼辦**
- Pages 沒更新：GitHub → Actions 重跑 pages build。這段期間店長看得到、記不了，資料不會丟。
- 打開後顯示「連不上」「後端沒有回正常資料」：Funnel 或伺服器有問題。Mac mini 的 Claude 先查 `curl -s http://127.0.0.1:8795/cashbook/health` 與 `tailscale funnel status`。**10 分鐘內修不好就照 `ROLLBACK.md` 回退**（這時 Mac mini 還沒收到任何新寫入，回退很快）。
- 瀏覽器 CORS 錯誤：確認 Funnel 網址的 `/cashbook/api` 路徑（不是根路徑）；`.env` 的 `ALLOW_ORIGIN` 預設已含 `https://eason0728.github.io`，不用改。

---

## 6. 實測清單（Eason 在手機上做；Mac mini 的 Claude 看 access log）

**負責人**：Eason 操作

**用店長的手機、通行碼不變、不重新輸入**（把 app 完全關掉再開，使用切換後的新版）：

- [ ] **登入**：輸入店長通行碼，進得去、清單顯示得出搬過來的舊帳（隨便點一個月份，筆數與舊試算表一致）。
- [ ] **記一筆**：記一筆測試支出（科目「雜支」、名稱「搬家測試」、金額 1），出現在清單；單號是延續舊編號的下一號（不是從 001 重來）。
- [ ] **作廢**：把剛才那筆作廢（原因「測試」），清單顯示「作廢」且不計入合計。
- [ ] **匯出**：匯出當月 Excel，開得起來、欄位與舊的一樣、剛才那筆作廢的有標示。
- [ ] **拍照**：記一筆（金額 1）並附收據照片，送出後清單的照片連結**點得開**，看到的是剛拍的照片（網址是 `https://<funnel 主機>/cashbook/photo/….jpg`）。舊帳的舊照片連結（舊 Google 雲端硬碟）原樣保留，也點得開。
- [ ] **設定頁**（會計）：頁尾進「設定」，輸入管理通行碼，讀得到科目清單；**不要改任何值**，只確認讀得到（或加一個科目再刪掉，視 Eason 意願）。
- [ ] **防重送**：記一筆時刻意連按兩次送出鈕，只記一筆。

測試帳務清掉：兩筆測試（金額 1）都**作廢**留著（作廢不刪，符合帳務原則），並告知會計月底匯出時忽略「搬家測試」。

Mac mini 的 Claude 確認：

```sh
grep -E "api:(bootstrap|list|create|update|void|adminGet) " "$DATA/logs/server.log" | tail -n 15      # 各動作都有 ok，耗時毫秒
```

**失敗怎麼辦**
- 登入失敗（`AUTH_FAIL`）：店長通行碼沒搬成雜湊？Mac mini 的 Claude 確認 migrate 輸出有「寫入完成」；請 Eason 在設定頁（管理通行碼）重設店長通行碼，再告知店長。
- 記不了／出錯：先看 `$DATA/logs/server.err.log`；`READONLY` 表示資料目錄有 `READONLY` 檔（只有回退才會建），不應出現。
- 拍照後連結空白或打不開：看 `.env` 的 `PUBLIC_BASE` 是否正確（`https://<funnel 主機>/cashbook`）；照片是否存在 `$DATA/photos/`。
- 任何一項**無法在 10 分鐘內修好** → 照 `ROLLBACK.md` 回退。回退前不要讓店長用新系統記真帳。

---

## 7. 損益系統連接器改指 Mac mini，並實打一次 `pnlSummary`

**負責人**：Eason（瀏覽器操作；金鑰 `PNL_KEY` Claude 不經手）

1. **Eason 在瀏覽器做**（Claude 不經手金鑰）：損益系統（`mala-pnl-auto` 網頁）→ **設定 → 連接器 → 現金帳那一列的 URL 欄**，由舊 Apps Script `/exec` 改成 `https://<funnel 主機>/cashbook/api`；**金鑰欄保持 `***` 不要重填**（沿用原金鑰，與 Mac mini `.env` 的 `PNL_KEY` 同一把）。⚠ 瀏覽器密碼自動填入曾把帳號塞進 URL 欄（2026-09-28 實例）：存檔前看一眼 URL 開頭是 `https://`。改完按「**立即拉取連接器**」。
2. **實打一次**：上面的「立即拉取連接器」就是實打；也可請 Eason 在自己的終端機另外確認：

```sh
read -rs "K?PNL_KEY（不回顯）："; echo
curl -s -X POST "https://<funnel 主機>/cashbook/api" -H 'Content-Type: text/plain' -d "{\"action\":\"pnlSummary\",\"key\":\"$K\",\"month\":\"$(date +%Y-%m)\"}" | python3 -m json.tool | head -20; unset K
```

   （新後端是普通 HTTP，這裡 `curl` 沒問題；不能用 curl 的只有舊 Apps Script。）
3. 驗證：回傳 `ok: true`，有 `expense`／`income` 兩個以科目為鍵的合計、`rows`、`locked`；**合計數字與舊試算表同月份用 Excel 加總的相同**（Eason 抽當月比一次）。

**失敗怎麼辦**
- `AUTH_FAIL`／金鑰錯：兩邊 `PNL_KEY` 不一致。損益系統那端改回舊網址（損益暫時走舊 Apps Script，數字是凍結時的，當月之後的帳要等回補），Eason 核對金鑰後重試。
- 數字對不上：**不要讓損益定稿**（`mala-pnl-auto` 的損益定稿月份先別按）；把月份與差額貼給 MacBook 的 Claude 查（常見：舊試算表有作廢列、或有科目名稱前後空白）。
- 連接器改回舊網址不影響本系統；損益那邊一切以「改回舊網址能運作」為底線。

---

## 8. 手動跑一次備份，確認備份試算表有資料

**負責人**：Mac mini 的 Claude（跑）＋Eason（看試算表）

```sh
DATA_DIR="$DATA" "$NODE" server/backup.js; echo "exit=$?"; curl -s http://127.0.0.1:8795/cashbook/health; echo
```

- 輸出「快照完成」「資料備份完成：rows N、frequent …」「照片備份：本次 … 張」「備份成功」、exit=0；`/health` 為 `green`、`backupAt` 是剛才。
- **Eason** 以 dingzhaoyuan5678 帳號打開「麻的小辛辣｜現金收支備份」試算表：**四個分頁「明細」「常用項目」「月結」「科目」都有資料**，「明細」的列數＝Mac mini 的筆數（含第 6 步的兩筆測試）。雲端硬碟「…收據照片備份」資料夾有照片（第 6 步拍的那張；單次最多補傳 50 張，舊照片本來在舊 Google 雲端硬碟不重送）。

**失敗怎麼辦**：照 `DEPLOY.md` 故障排除 E。備份失敗**不影響記帳**，但不要等到隔天才處理——當天修好，否則 `/health` 26 小時後轉紅、守門寄信。

---

## 9. 隔天確認

**負責人**：Mac mini 的 Claude ＋ MacBook 的 Claude

- [ ] 03:50 備份已自動跑成功：`tail -n 8 "$DATA/logs/backup.out.log"` 有昨晚到今早的「備份成功」；`/cashbook/health` 為 `green` 且 `backupAt` 在今早 03:50 之後。備份試算表「明細」筆數＝Mac mini 筆數。
- [ ] 守門的「現金帳伺服器」那格為綠（**已在 0-9 上線**；切換後 `config.js` 指向 `.ts.net` 的 `/cashbook/api`，守門 07:30 起改打 `/cashbook/health`；看指揮台艦隊同名那格與 `gh run list --repo Eason0728/mala-fortune --workflow cashbook_health.yml` 最新一筆）。
- [ ] 店長昨天下午的真帳正常記在新系統（`list` 看得到），單號連續。
- [ ] Mac mini 的程式改追 main：`cd ~/mala-cashbook && git fetch && git checkout main && git pull --ff-only`，確認 `git log -1` 與 GitHub main 相同後重啟服務（`sudo launchctl kickstart -k system/com.mala.cashbook`，Eason），`/cashbook/health` 仍綠。之後所有更新都從 main pull。

**失敗怎麼辦**：備份沒跑 → `sudo launchctl print system/com.mala.cashbook.backup | grep -E 'state|last exit'`（Eason），手動跑一次看錯誤（DEPLOY 故障排除 E）；守門紅燈 → 照守門訊息指的原因處理，不要先回退（資料還在 Mac mini，回退要經 `ROLLBACK.md` 匯出，不是按鍵就好）。

---

## 10. 觀察 3 天速度（spec §10）

**負責人**：Mac mini 的 Claude，每天看一次，連續 3 天

驗收標準：**伺服器端每個動作 p95 < 200 毫秒；手機端登入、記一筆（不含照片）中位數 < 1 秒；連續 3 天前端沒有任何一次 20 秒逾時**。

```sh
# access log 每行結尾是耗時毫秒（api:<action> ok|<錯誤碼> <N>ms）。算每個動作的 p95 與最大值：
python3 - <<'EOF'
import os, re, collections
f = os.path.expanduser('~/mala-cashbook-data/logs/server.log'); d = collections.defaultdict(list)
for l in open(f, errors='ignore'):
    m = re.search(r' (api:\w+|health|photo) (\S+) (\d+)ms', l)
    if m: d[m.group(1)].append(int(m.group(3)))
for k, v in sorted(d.items()):
    v.sort(); print(f'{k:16s} n={len(v):5d} p50={v[len(v)//2]:4d}ms p95={v[int(len(v)*0.95)-1 if len(v)>1 else 0]:4d}ms max={v[-1]}ms')
EOF
grep -c ' SERVER_ERROR ' "$DATA/logs/server.log"                    # 期望 0
```

- 逾時要從**店長端**感受：Eason 每天問店長「有沒有出現逾時／網路太慢」；超過 20 秒的請求在 server log 會是耗時 > 20000ms 的行（`awk '$4+0 > 20000' "$DATA/logs/server.log"`，第 4 欄是耗時），一次都不該有。
- 3 天都達標 → 在 `docs/macmini/progress.md` 記「觀察完成」，舊 Apps Script **保留凍結狀態不刪**（作存證與回退；至少再留 30 天）。
- **回退演練**（建議，觀察期結束後做一次，見 `ROLLBACK.md` 附錄）：照 ROLLBACK 做到第 4 步 dry-run 即可，確認 `rollback-export.js --dry-run` 認得到切換後的列。

**失敗怎麼辦**：p95 超標 → 看是哪個動作（通常是照片 base64 解碼、`list` 月份太大）；用 `sqlite` 查慢的月份、確認磁碟沒滿、Mac mini 沒在跑別的重工作（貨單辨識的 Ollama 會吃 CPU／記憶體，記錄是否與慢的時段重疊）。有逾時 → 先看是店長手機網路還是伺服器（server.log 該時段有沒有對應的請求）；伺服器端慢且找不到原因 → 回報 Eason，評估是否回退。
