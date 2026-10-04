# 回退手冊：Mac mini → Apps Script（現金收支登記，T10）

本手冊用在兩種情況：

- 切換後出問題，要退回舊 Apps Script＋舊試算表。
- 觀察期結束後的**回退演練**（建議做到第 4 步 dry-run；見附錄 B）。

照 `docs/macmini/spec.md` §9「回退」，嚴謹度照 `~/dzy-bulletin/server/ROLLBACK.md`。切換見 [`CUTOVER.md`](CUTOVER.md)。

> **角色**
> - **Eason**：舊 Apps Script 指令碼屬性（`FROZEN`、`ROLLBACK_KEY`）、群組通知、通行碼輸入、手機實測。
> - **Mac mini 的 Claude**：只在 Mac mini 上跑指令。
> - **MacBook 的 Claude**：前端 `js/config.js`、`sw.js`、push、損益系統連接器。
>
> **Claude 絕不經手任何金鑰或通行碼**（`ROLLBACK_KEY`、`OLD_PASS`、`PNL_KEY`、管理與店長通行碼）：由 Eason 在自己的終端機輸入，不印出、不貼對話、不寫檔。

## 先分清楚是哪一種

| 狀況 | 走哪條 | 丟失 |
|---|---|---|
| Mac mini **還活著**（伺服器、資料庫都在） | 第 1 → 2 → 3 → 4 → 5 → 6 → 7 步，順序固定、不可調換 | 0 筆（前提是第 1 步先做） |
| Mac mini **死了**（開不了機、資料庫讀不到） | 〈Mac mini 死了的回退〉 | 上一次備份（每天 03:50）之後的帳 |

**鐵則**

1. Mac mini 活著時，**第 1 步 `READONLY` 一定最先做**：不做的話，從匯出到前端改回之間，店長仍能在 Mac mini 記帳，這段會丟。
2. **先把帳匯回舊試算表並核對（第 3～4 步），再解除舊 Apps Script 的 `FROZEN`（第 6 步），最後才改前端網址（第 7 步）。** 反過來做的話，店長會在「還沒有最新帳的舊系統」上記帳、單號與收據編號會撞。
3. **第 7 步生效之後，絕對不可以再把前端改回 Mac mini、也不可以再對舊試算表跑 `importRows`**——店長已經在舊系統記新帳，`importRows` 以單號覆寫會蓋掉它們。要再切回來，只能走附錄 A（重新搬資料，不是「繼續」）。
4. `rollback-export.js` 只寫舊試算表，**不改 Mac mini 的資料庫**；Mac mini 的 `cashbook.db` 與 `photos/` 全程保留。
5. 舊試算表在做任何事之前，Eason 先**複製一份當備份**（檔案 → 建立副本，名稱加日期），回退出問題時用。

下面的指令在 **Mac mini、repo 根目錄**執行。**每一段指令前都要先貼這一行**（Claude 每次 Bash 呼叫是新的 shell）：

```sh
cd ~/mala-cashbook; export PATH="$HOME/.local/node/bin:$PATH"; NODE="$HOME/.local/node/bin/node"; DATA="$HOME/mala-cashbook-data"; command -v node   # 要印出 …/.local/node/bin/node
```

---

## 1. 凍結 Mac mini：建立 `READONLY` 檔

**負責人**：Mac mini 的 Claude

```sh
touch "$DATA/READONLY"
cp "$DATA/cashbook.db" "$DATA/cashbook.db.before-rollback-$(date +%Y%m%d-%H%M)"      # 保險：整份資料庫複製一份（WAL 模式下 cp 可能漏最近的寫入，快照由下一行的備份產生）
DATA_DIR="$DATA" "$NODE" server/backup.js; echo "exit=$?"                              # 順便把最新資料備份到雲端（備份失敗不擋回退，但記下來）
ls -l "$DATA/READONLY"
```

**驗證**：`READONLY` 之後，所有寫入回 `READONLY`，讀取照常。請 **Eason 在自己的終端機**確認（通行碼只在他自己的終端機輸入）：

```sh
read -rs "P?店長通行碼（不回顯）：" P; echo
curl -s -X POST http://127.0.0.1:8795/cashbook/api -H 'Content-Type: text/plain' -d "{\"action\":\"void\",\"pass\":\"$P\",\"id\":\"0000-00-000\"}"; echo     # 要回 {"ok":false,"error":"READONLY"}
curl -s -X POST http://127.0.0.1:8795/cashbook/api -H 'Content-Type: text/plain' -d "{\"action\":\"bootstrap\",\"pass\":\"$P\"}" | head -c 80; echo                # 要回 {"ok":true,…（讀取照常）
unset P
```

（`id` 是不存在的單號，萬一沒擋住也不會作廢任何帳。）

**失敗怎麼辦**
- `touch` 失敗（權限、磁碟滿）：**不要往下做**。`df -h "$DATA"`，排除後重做；真的做不到，改走〈Mac mini 死了的回退〉並接受丟失。
- 沒回 `READONLY`：`READONLY` 可能建在錯的資料夾。看 `$DATA/logs/server.log` 啟動訊息的 `data=` 路徑，在那個路徑底下再 `touch` 一次。
- 1 分鐘後 `"$NODE" -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/cashbook.db',{readOnly:true});console.log(d.prepare('SELECT COUNT(*) n, MAX(created_at) m FROM rows').get())" "$DATA"` 兩次的結果要相同（Mac mini 已不再收寫入）。

---

## 2. 舊試算表先備份；確認舊 Apps Script 仍凍結、金鑰在手

**負責人**：Eason

- [ ] 舊試算表（madesiaosinla 帳號）→ 檔案 → 建立副本（名稱加日期，例如「現金收支-回退前-20261012」）。
- [ ] 舊 Apps Script 指令碼屬性：`FROZEN` 仍是 `1`、`ROLLBACK_KEY` 還在（值是切換前 0-3 存進密碼管理器的那一把；**屬性被刪或忘了就重設一把新的，Mac mini 這邊用新的**）。
- [ ] 舊 Apps Script 的網址：切換前存進密碼管理器那串，或 `git -C ~/mala-cashbook show <切換前 commit>:js/config.js` 取 `GAS_URL`（在 MacBook 上做，不貼對話）。
- [ ] 若舊 Apps Script 切換後被動過（重新部署過、換了部署 ID），確認這串網址仍是**含 `importRows` 的版本**：Eason 在瀏覽器 Console 對它 `fetch` 一次 `{action:'importRows',key:'x',rows:[]}`，要回 `{"ok":false,"error":"AUTH"}`（而不是 `BAD_INPUT`／其他），代表 `importRows` 存在、金鑰擋得住。**不要用 curl 測。**

---

## 3. 匯出：先 dry-run 看清楚要寫回哪些列

**負責人**：Eason 在終端機設變數，Mac mini 的 Claude 看輸出

`server/tools/rollback-export.js` 把「切換後新增或修改的列」寫回舊試算表。選列規則：

1. **切換後新增**：`created_at` 晚於遷移時間（`meta.migrated_at`，`migrate.js` 正式寫入時記下；沒有就要用 `--since` 指定）。
2. **切換後作廢**：`voided_at` 晚於遷移時間。
3. **加 `--compare-old`（本手冊一律要加）**：再讀舊試算表，凡是跟舊試算表內容**不同**的列也送（抓得到「切換後被修改」的舊帳——`update` 不留修改時間，單看時間戳會漏掉）。

用 `importRows`（舊 Apps Script 以單號 upsert：有就整列覆寫 17 欄，沒有就新增；一次最多 2000 列，工具自動每 500 列分批；`hasInvoice` 一律送 boolean）。**舊試算表不會有任何列被刪除**；Mac mini 沒有的舊列原樣留著。

**Eason 在自己的終端機**（金鑰與通行碼不回顯、用完清掉）：

```sh
cd ~/mala-cashbook; export PATH="$HOME/.local/node/bin:$PATH"
export OLD_GAS_URL="<舊 Apps Script 網址，取自密碼管理器>"
read -rs "ROLLBACK_KEY?ROLLBACK_KEY（不回顯）：" ROLLBACK_KEY; echo; export ROLLBACK_KEY
read -rs "OLD_PASS?舊店長通行碼（不回顯）：" OLD_PASS; echo; export OLD_PASS
node server/tools/rollback-export.js --dry-run --compare-old
```

- 印出「切換時間點（since）」（應等於 CUTOVER 第 4 步遷移完成的時間）、「要寫回舊試算表的列：N 筆（依時間 X、依比對舊試算表另外補 Y）」與每一筆的單號和原因（切換後新增／切換後作廢／與舊試算表內容不同）。`--dry-run` **只讀不寫**，也不需要 `ROLLBACK_KEY`。
- **人工核對**：N 應該約等於「切換後店長記的筆數＋作廢筆數＋第 6 步實測留下的兩筆測試＋被修改的舊帳」。**N＝0 但你知道切換後有記帳** → `meta.migrated_at` 沒寫到或時間不對：改用 `--since <遷移時間，台北時間 YYYY-MM-DDTHH:mm:ss+08:00>` 指定（遷移時間看 CUTOVER 第 4 步輸出的時間或 Mac mini 的 `deploy-evidence.txt`）。

**失敗怎麼辦**
- 「錯誤：meta 沒有 migrated_at」：照上面用 `--since` 指定。
- 「失敗：呼叫舊後端失敗（重試 3 次）」：舊 Apps Script 暫時不通，等 1～2 分鐘重跑（dry-run 的 `--compare-old` 會打舊後端讀取）。
- 「舊後端回報：AUTH_FAIL」：`OLD_PASS` 打錯，重新輸入（連錯多次舊後端會暫時鎖定，等 10 分鐘）。

---

## 4. 匯出：正式寫回舊試算表，並核對

**負責人**：Eason 在同一個終端機視窗（變數還在）

```sh
node server/tools/rollback-export.js --compare-old; echo "exit=$?"
```

- 期望輸出：「寫回完成：新增 X、更新 Y（共送出 N）」，**X＋Y＝N**、exit=0。
- **核對 1（Eason 看舊試算表）**：「明細」分頁列數（扣掉表頭）＝ Mac mini 的 rows 筆數；切換後新增的單號都在、作廢的列「狀態」是「作廢」且有作廢時間與原因。抽 3 筆新帳比對金額、科目、收據編號、發票欄（有／無）。
- **核對 2（機器比對）**：以 Mac mini 資料庫對照舊試算表，rows 層級要全一致：

```sh
node server/tools/migrate.js --verify-only; echo "exit=$?"
```

  - 看**月合計表**每一行都是 `OK`（筆數／支出／收入／作廢），以及逐筆比對**沒有任何以單號開頭的差異行**（`2026-10-003.amount：…` 這種）。
  - **`frequent`（常用項目）與 `locks`（月結）的差異是預期的**（Mac mini 上的常用項目使用次數更新過、月結可能多了新的）——`importRows` 不處理這兩項，見第 5 步。有差異時整體 exit=1 是正常的，**只要 rows 層級沒有差異就算通過**。
- 做完立刻：`unset ROLLBACK_KEY OLD_PASS OLD_GAS_URL`，清空終端機視窗與捲動紀錄（⌘K）。

**失敗怎麼辦**
- `importRows` 回 `AUTH`（「舊後端回報：AUTH」）：`ROLLBACK_KEY` 與舊 Apps Script 指令碼屬性不一致。Eason 核對屬性（可重設一把新的、同時重新輸入）後重跑——**重跑安全**（以單號 upsert，同一批再送一次結果相同）。
- `importRows` 回 `BAD_INPUT`：payload 有問題（極少見；單次超過 2000 列或單號缺）。把輸出貼給 MacBook 的 Claude 查，**不要硬改**。
- 中途連線失敗（已送出一部分）：直接整個重跑，`importRows` 是 upsert、冪等；重跑後以核對 1、2 為準。
- 核對 1 不符（列數不對、金額不同）：**不進第 6 步**。把差異（只含單號與欄位名）貼給 MacBook 的 Claude；必要時用第 2 步的副本還原舊試算表，從第 3 步重來。**Mac mini 此時仍是唯讀、資料完整，店長暫時不能記帳但不會丟**。

---

## 5. 補手動項目：月結鎖定、設定、照片

**負責人**：Eason（對照 Mac mini 的輸出）＋Mac mini 的 Claude

`importRows` 只回帳目列。下面三項要人工補：

1. **月結鎖定**：Mac mini 上若切換後鎖了新的月份，舊系統沒有。Mac mini 的 Claude 列出：
   ```sh
   "$NODE" -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]+'/cashbook.db',{readOnly:true});console.log(d.prepare('SELECT month, locked_at FROM locks ORDER BY month').all())" "$DATA"
   ```
   跟舊系統（用舊前端登入，看已鎖月份）比對；缺的月份由 Eason 在舊系統的鎖定功能補鎖。**鎖定動作在凍結期間會被擋，所以順序是：第 6 步解除 `FROZEN` → 立刻補鎖 → 才做第 7 步改前端網址**（前端還指向 Mac mini 期間，店長打不到舊系統，不會有人在補鎖前記帳）。
2. **科目、店長通行碼**：Mac mini 設定頁若改過科目清單或店長通行碼，舊系統不會跟著變。Eason 到舊試算表「設定」分頁手動補（科目）；店長通行碼若在 Mac mini 改過，告知店長「通行碼已換回舊的／或改成新的」，舊系統通行碼在「設定」分頁。
3. **照片**：切換後在 Mac mini 拍的照片，連結是 `https://<funnel 主機>/cashbook/photo/….jpg`，匯回舊試算表的「照片連結」欄**原樣保留**。**Mac mini 活著、Funnel 開著時這些連結仍然點得開**；Mac mini 之後要下線，連結會失效——此時照片檔在 `$DATA/photos/`（以及備份用 Apps Script 的雲端硬碟資料夾，檔名 `<單號>_<token>.jpg`），Eason 再決定要不要把它們另外上傳整理。

---

## 6. 舊 Apps Script 解除凍結（刪除 `FROZEN`）

**負責人**：**Eason 親手**（Apps Script 編輯器 → 專案設定 → 指令碼屬性 → 刪除 `FROZEN` → 儲存）

**驗證**（瀏覽器 Console，不要用 curl；通行碼只在這裡輸入）：

```js
(async () => {
  const pass = prompt('舊店長通行碼（只在這裡輸入）');
  const post = (b) => fetch('<舊 Apps Script 網址>', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(b) }).then((r) => r.json());
  const v = await post({ action: 'void', pass, id: '0000-00-000' });
  const l = await post({ action: 'bootstrap', pass });
  console.log('void（不存在的單號）→', v.ok, v.error, '｜bootstrap →', l.ok);
})();
```

- 期望 `void（不存在的單號）→ false NOT_FOUND`（**不是 `MOVED`**＝凍結已解除，且不存在的單號不會寫任何東西）、`bootstrap → true`。
- 此時前端仍指向 Mac mini（唯讀），店長還不會打到舊系統；補完第 5 步的鎖定再做第 7 步。

**失敗怎麼辦**：仍回 `MOVED` → 屬性沒刪成功（或打到別的部署）；重新整理 Apps Script 頁面確認 `FROZEN` 不在。回 `AUTH_FAIL` → 通行碼輸錯。

---

## 7. 前端網址改回舊的、損益連接器改回、通知店長

**負責人**：MacBook 的 Claude（Eason 核准 push）；Eason 發群組

1. **前端**：`js/config.js` 的 `GAS_URL` 改回舊 Apps Script 網址（Eason 提供；或 `git show <切換前 commit>:js/config.js` 取）；`sw.js` 的 `VERSION` **再加一**（舊快取要清掉，不是退回舊號）。

   ```sh
   cd ~/mala-cashbook && git checkout main
   # 編輯 js/config.js、sw.js
   git add js/config.js sw.js && git commit -m "回退：前端改回舊 Apps Script 後端" && git push origin main
   curl -s https://eason0728.github.io/mala-cashbook/js/config.js | grep -c "script.google.com"     # 約 30～60 秒後要回 ≥ 1
   ```
2. **損益系統連接器**（Eason 在瀏覽器做）：損益系統網頁 → 設定 → 連接器 → 現金帳那一列的 URL 欄，由 `https://<funnel 主機>/cashbook/api` 改回舊 Apps Script `/exec`；**金鑰欄保持 `***` 不重填**；存檔前看一眼 URL 開頭是 `https://`（防瀏覽器密碼自動填入）。按「立即拉取連接器」實打，回 `ok:true`、合計與舊試算表當月加總一致。損益若已定稿的月份，請 Eason 確認沒有因為回退而變動。
3. **Eason 發群組**：「現金收支登記暫時換回原本的系統，請把 app 完全關掉再重新打開，通行碼不變（若在新系統改過通行碼，請照 Eason 通知）。之前記的帳都在。」
4. **實測（店長手機）**：登入、看得到切換後新記的帳、記一筆、作廢一筆、匯出。**店長記的第一筆單號要接在切換後最大單號之後**（不是撞號）。
5. Mac mini：`READONLY` **保留著**（不要刪），伺服器與備份排程可繼續跑（備份讀的是 Mac mini 資料庫，內容不會再變；也可以先停掉備份 job——由 Eason 決定，用 `sudo launchctl bootout system/com.mala.cashbook.backup`）。第 7 步改回 Google 後，守門判「略過」屬正常；若 Mac mini 的備份 job 停掉，26 小時後 `/cashbook/health` 會轉紅，但守門此時已不檢查。

**失敗怎麼辦**
- Pages 沒更新：GitHub → Actions 重跑 pages build。期間店長看得到、記不了（前端仍打 Mac mini，回 `READONLY`；錯誤文案提示請重開 app）。
- 店長仍看到舊畫面：app 完全關掉再開；iPhone 加到主畫面的版本要刪掉重加或等 `sw.js` 新版本啟用。
- 舊系統記不了（`MOVED`）：第 6 步沒做好，回第 6 步。

---

## Mac mini 死了的回退（開不了機、資料庫讀不到）

資料只剩**上一次備份**（每天 03:50）：備份用 Apps Script（dingzhaoyuan5678 帳號）的試算表「麻的小辛辣｜現金收支備份」有「明細」「常用項目」「月結」「科目」整頁內容；照片在雲端硬碟「…收據照片備份」資料夾。

1. **Eason** 立刻：舊 Apps Script 刪除 `FROZEN`（第 6 步），前端改回舊網址（第 7 步，MacBook 的 Claude 協助）。**店長先能繼續記帳最重要。**
2. **補回上次備份之後的帳**：打開備份試算表「明細」，依「登記時間」（`createdAt`，欄 N）篩出**晚於遷移時間**的列（切換後新增的）與「作廢時間」（欄 P）晚於遷移時間的列（切換後作廢的）。這些是「備份當下」已有的切換後帳。
   - 數量少：Eason 在舊系統用 app 手動補記（作廢的標作廢）。
   - 數量多：把備份試算表「明細」的那些列轉成 `importRows` 格式（`hasInvoice`＝「有」→ `true`，其餘 `false`；金額、未稅價、稅額、收據編號轉數字），交給 MacBook 的 Claude 另寫一次性腳本，用同一套 `ROLLBACK_KEY`／`importRows` 寫回。
   - **備份之後到停機之間的帳（最多一天）已經丟了**：請店長依紙本／收據補記，這段時間的單號由她重新記；先告知會計。
3. 月結鎖定：看備份試算表「月結」分頁，跟舊系統比對補鎖（第 5 步第 1 項）。
4. 損益連接器改回舊網址（第 7 步第 2 項）。
5. Mac mini 修好之後**不要直接接回使用**：它的資料庫已經落後舊試算表。要再切回來走附錄 A。

---

## 附錄 A：回退之後想再切回 Mac mini

**這是一次新的搬遷，不是「繼續」**：舊試算表現在才是正本（店長已在上面記新帳），Mac mini 的資料庫是舊的。

1. Mac mini：`READONLY` 先留著；把舊資料庫與照片整個搬開存證，不是覆蓋——
   `mv "$DATA" "$DATA.rolled-back-$(date +%Y%m%d)"; mkdir -p "$DATA/logs"; chmod 700 "$DATA"`（**先請 Eason `sudo launchctl bootout system/com.mala.cashbook`** 停掉伺服器，否則伺服器手上還開著舊庫；搬完再 `bootstrap` 回來）。舊照片 `photos/` 若要保留舊照片連結有效，**把舊資料夾的 `photos/` 複製回新資料夾**（連結是 `…/cashbook/photo/<token>.jpg`，伺服器只認 `$DATA/photos/`）。
2. 從 `CUTOVER.md` 第 0 步開始**整份重做**：群組通知、舊 Apps Script 設 `FROZEN=1`、`migrate.js --dry-run` → 正式 → 比對全過（正式加 `--replace` 不需要，因為資料夾是新的）→ 前端改指 Mac mini → 實測 → 損益連接器。
3. 回退期間舊試算表上新記的帳會一併搬過來（`migrate.js` 讀的是舊試算表目前全部內容）；單號與收據編號延續舊試算表最大值。
4. 再切回來之前，先找出第一次回退的根因並修好，否則會再回退一次。

## 附錄 B：回退演練（觀察期結束後建議做一次）

不要真的凍結、不要真的寫舊試算表：

1. 在 Mac mini 跑 `node server/tools/rollback-export.js --dry-run --compare-old`（Eason 在終端機輸入 `OLD_GAS_URL`／`OLD_PASS`）：只讀不寫。
2. 確認「切換時間點」等於切換當天的遷移時間、「要寫回的列」數量與切換後店長實際記的筆數大致相符（含第 6 步測試的兩筆）、`importRows` 會送出的單號清單合理。
3. 確認 Eason 能找到 `ROLLBACK_KEY`（密碼管理器）、舊 Apps Script 網址、舊店長通行碼。
4. 結論記進 `docs/macmini/progress.md`。
