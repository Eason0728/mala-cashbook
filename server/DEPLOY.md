# 麻的小辛辣｜現金收支登記 — Mac mini 部署手冊（T10）

給 **Mac mini 上的 Claude** 從頭照做。做完＝伺服器在 Mac mini 常駐（埠 8795）、每天 03:50 自動備份、停電重開後（解鎖磁碟即可）自己恢復、
手機用 4G 經 Tailscale Funnel 的 **`/cashbook` 路徑**打得到 `/cashbook/health`，而且**電子佈告欄（埠 8793，根路徑 `/`）與貨單（埠 8794，`/purchase`）完全不受影響**。

本手冊照貨單的做法（`~/mala-purchase/DEPLOY.md`）與佈告欄附錄 A（`~/dzy-bulletin/server/DEPLOY.md`，FileVault 開著走 LaunchDaemon）；定案沿用：Node 24 裝在 `~/.local/node`、LaunchDaemon（system domain）、`.env` 不得打開、Tailscale 沿用佈告欄那一個。
**本手冊只部署、不搬資料**：部署完是空資料庫。搬資料與切換前端見 [`CUTOVER.md`](CUTOVER.md)；出事退回見 [`ROLLBACK.md`](ROLLBACK.md)。

每步開頭標明誰做：**【Claude】**＝Mac mini 上的 Claude，**【Eason】**＝Eason 本人（sudo、金鑰、MacBook、手機）。標【Eason】的步驟 Claude 把清單整段貼給他然後**停下來等他說「做完了」**。

---

## ⛔ 最前面：禁令（違反任一條＝部署失敗，要請 Eason 換金鑰）

`server/.env` 裝著 `ADMIN_INIT`（管理通行碼初始值）、`PNL_KEY`（損益系統金鑰）、`BACKUP_KEY`（備份金鑰）。Mac mini 的 Claude：

1. **不** `cat`／`less`／`head`／`tail`／`open`／`echo`／`Read` 這個檔，也不用任何工具「看一下內容」。
2. **不** 執行會把環境變數全印出來的指令：`env`、`printenv`、`set`、`export -p`、`launchctl getenv …`、`ps eww`。
3. **不** 把 `.env` 的內容或片段貼進對話、issue、留言、commit、檔案。
4. **不** 自己產生、也不經手任何金鑰與通行碼（`ADMIN_INIT`、`PNL_KEY`、`BACKUP_KEY`、店長通行碼）：一律由 Eason 在**他自己開的「終端機」App 視窗**裡產生並寫入。Claude 只准寫入 `.env` 的**非祕密行**（第 2 步列的那幾行）。
5. 要確認 `.env` 格式，只准用「回傳數字」的指令（`grep -c …`）。**時序規則：第 3 步 B2 的 Read 禁止規則生效之前，Claude 可以跑這種回傳數字的 grep；B2 生效之後，一律由 Eason 在終端機執行、回報數字**（B2 只擋 Read／Edit 工具，擋不到 Bash，所以 B2 之後仍靠紀律，不要用 Bash 去讀 `.env`）。
6. `.env` 不進 git（`.gitignore` 已列 `server/.env`），權限 `600`。
7. **不碰佈告欄與貨單**：不修改 `~/dzy-bulletin*`、`~/mala-purchase`、`~/dzy-purchase*`、`com.dzy.*` 任何 job、它們的 `.env`、埠 8793／8794；Funnel 根路徑 `/` 與 `/purchase` 的設定一個字都不動（第 6 步只**新增** `/cashbook` 這一條）。
8. **Funnel 網址（主機名）不得寫進任何 repo 檔案、issue、commit 訊息、證據檔**；對話中只在第 6 步當下交給 Eason。手冊與 plist 一律用 `<funnel 主機>` 佔位。唯一例外：`server/.env` 的 `PUBLIC_BASE`（不進 git）與 Eason 在 MacBook 切換時改的前端 `js/config.js`（CUTOVER 第 5 步）。

---

## 手冊約定

- 所有路徑都從 `$HOME` 推導，手冊裡沒有任何人的帳號名稱。程式在 `$HOME/mala-cashbook`、資料在 `$HOME/mala-cashbook-data`（**不要**放在桌面／文件／下載底下，macOS 會擋背景程式讀）。
- `TS`＝Tailscale CLI：沿用佈告欄那一個（FileVault 路線是 Homebrew 的 `tailscaled`，用 `command -v tailscale`；有官方 App 就用 App 裡的）。**不另裝、不換**。
- 三個服務並存：佈告欄 `8793`（`BPORT`）、貨單 `8794`（`PPORT`）、本系統 `8795`（`PORT`）；launchd 名稱（`com.mala.cashbook*`）、資料夾、`.env` 全部分開。
- **每段指令前都要先貼這一行**（每次 Bash 呼叫是新的 shell，變數不會留著；`export PATH` 讓子程序也用 `~/.local/node` 的 Node 24）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); PORT=8795; BPORT=8793; PPORT=8794
```

- 「**既有服務基準**」＝部署前（第 0 步）、第 6 步改完、第 8 步結束後都要印、都要完全一致，**不一致就照第 6 步回退**。共六個值：佈告欄 `/health` 的 `ok／level`、貨單 `/purchase/api/health` 的 `ok／status`，以及對外入口的兩個計數（光看本機埠測不到 Funnel 被關掉，所以一定要有後兩值）：

```sh
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("bulletin", {k: d.get(k) for k in ("ok","level")})'
curl -s --max-time 10 http://127.0.0.1:8794/purchase/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("purchase", {k: d.get(k) for k in ("ok","status")})'
F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$') purchase_8794=$(echo "$F" | grep -cE '^\|-- +/purchase +proxy +http://(127\.0\.0\.1|localhost):8794/purchase$')"    # 期望 funnel_on=1 root_8793=1 purchase_8794=1
```

  後一行的判讀式**以實際 `tailscale funnel status` 輸出為準**：第 0 步若看不到形如 `|-- / proxy http://127.0.0.1:8793` 與 `|-- /purchase proxy http://127.0.0.1:8794/purchase` 的兩行、致使計數不是 1，**停下來把輸出（網址已遮蔽）貼給 Eason**，不要自己改判讀式。
- 背景程序一律寫成「單一指令加 `&`、下一行 `echo $! > pid 檔`」；只關自己記下的那個 PID。等伺服器起來用 `curl --retry … --retry-connrefused`，不用 `sleep`。
- **驗收要用的數據一律落檔**：寫進 `$DATA/logs/deploy-evidence.txt`（環境、既有服務基準、`/health`、XFF 實測…）。這個檔**不可含金鑰、網址、tailnet 名稱**；回報時從這個檔讀。
- 中途要關掉 Claude 或重開機時，請 Eason 回來後在**同一個資料夾**打 `claude --continue`，再說「繼續照 server/DEPLOY.md 第 N 步」；接回後 Claude 先 `cat "$HOME/mala-cashbook-data/logs/deploy-evidence.txt"`（這個檔可以印）確認做到哪裡。
- **本手冊走路線 D（LaunchDaemon）**：與佈告欄、貨單同一台機器、同一條路線，FileVault 開著、開機即跑；代價是停電重開後要有人在 FileVault 解鎖畫面輸入密碼（見佈告欄附錄 A）。Claude 沒有 sudo：`/Library/LaunchDaemons/` 的複製與 `launchctl bootstrap system` 一律交給 Eason。

---

## 第 0 步：查現況並回報【Claude】（只讀；唯一例外是建立自己的 `$DATA/logs` 與證據檔）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale ); PORT=8795
echo "== 使用者"; whoami; echo "HOME=$HOME uid=$(id -u) shell=$SHELL"
echo "== FileVault"; fdesetup status
echo "== macOS／時區／磁碟"; sw_vers -productVersion; date; readlink /etc/localtime; df -h "$HOME" | tail -1
echo "== Tailscale"; "$TS" version | head -1; "$TS" status | head -3
echo "== Node（需要 ≥ 24，node:sqlite）"; "$NODE" -v 2>/dev/null && "$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')" || echo "（~/.local/node 尚未安裝或不是 24）"
echo "== git／repo"; git --version | head -1; git -C "$REPO" log --oneline -1 2>/dev/null && git -C "$REPO" branch --show-current || echo "（尚未 clone）"
echo "== 埠 $PORT／8793／8794"; lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "（$PORT 沒人在聽，正常）"; lsof -nP -iTCP:8793 -sTCP:LISTEN | head -2; lsof -nP -iTCP:8794 -sTCP:LISTEN | head -2
echo "== 既有 job"; ls /Library/LaunchDaemons/com.dzy.* /Library/LaunchDaemons/com.mala.* 2>/dev/null
echo "== 本系統既有 job／資料"; ls /Library/LaunchDaemons/com.mala.cashbook* ~/Library/LaunchAgents/com.mala.cashbook* 2>/dev/null || echo "（無）"; ls -d "$DATA" 2>/dev/null || echo "（無 $DATA）"
echo "== Funnel／Serve 現況（網址已遮蔽）"; "$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<funnel 主機>#g'; "$TS" serve status 2>&1 | sed -E 's#https?://[^ /]+#https://<funnel 主機>#g'
echo "== 既有服務基準"
curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("bulletin", {k: d.get(k) for k in ("ok","level")})'
curl -s --max-time 10 http://127.0.0.1:8794/purchase/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("purchase", {k: d.get(k) for k in ("ok","status")})'
F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$') purchase_8794=$(echo "$F" | grep -cE '^\|-- +/purchase +proxy +http://(127\.0\.0\.1|localhost):8794/purchase$')"
echo "== funnel／serve 有沒有 --set-path"; for c in funnel serve; do echo "$c: set-path=$("$TS" $c --help 2>&1 | grep -c -- '--set-path') yes=$("$TS" $c --help 2>&1 | grep -c -- '--yes')"; done
```

判讀與回報（把下表填好貼給 Eason，**然後停下來等他確認**）：

| 項目 | 期望 | 不符時 |
|---|---|---|
| Node | `~/.local/node` 為 v24.x 且 `node:sqlite OK` | 沒有：**停**，請 Eason 決定（佈告欄／貨單共用這個 Node，照 `~/dzy-bulletin/server/DEPLOY.md` 第 1 步裝；不要用 Homebrew 的 `node`） |
| 磁碟 | `$HOME` 可用 ≥ 10 GB | 不足：**停**，回報 |
| 既有 job | `/Library/LaunchDaemons/` 有佈告欄與貨單的 `com.dzy.*`（＝路線 D） | 在 `~/Library/LaunchAgents/` 而不在 LaunchDaemons：本系統的 plist 仍照第 5 步做成 LaunchDaemon（Eason 已定案走 D），回報即可；兩邊都沒有：**停**，回報 |
| Tailscale | 已連線、是佈告欄在用的那一個 | `Logged out`：**停**，請 Eason 處理 |
| 埠 8795 | 沒人在聽 | 有人在聽：查是誰，**停**，請 Eason 決定 |
| 本系統既有 job／`$DATA` | 無 | 有的話**停**，不要覆蓋，回報 Eason |
| 既有服務基準 | 佈告欄 `ok` 為 `True`、貨單 `ok` 為 `True`；`funnel_on=1 root_8793=1 purchase_8794=1` | **停**。既有服務本來就壞或 Funnel 狀態不同，不能在這個狀態上動 Funnel，先回報 Eason |
| `funnel --help` | 有 `--set-path`；記下有沒有 `--yes` | 沒有 `--set-path`＝這個版本不支援路徑分流，**停** |

**第 6 步的前置確認（必做）**：把 `tailscale version` 與 `funnel --help` 的輸出（網址已遮蔽）貼給 Eason，等他確認「可以做第 6 步」才進第 6 步。

把基準與 Funnel 現況存進證據檔與回退參考檔（**網址已遮蔽；不含金鑰**）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"; TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
mkdir -p "$DATA/logs" && chmod 700 "$DATA"
{ echo "== 現金帳部署證據（不含金鑰、網址）"
  echo "環境：macOS $(sw_vers -productVersion)／$(uname -m)／Node $("$NODE" -v 2>/dev/null)／建立 $(date '+%F %T %Z')"
  echo "第 0 步 既有服務基準：$(curl -s --max-time 10 http://127.0.0.1:8793/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("bulletin", {k: d.get(k) for k in ("ok","level")})')／$(curl -s --max-time 10 http://127.0.0.1:8794/purchase/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("purchase", {k: d.get(k) for k in ("ok","status")})')／$(F=$("$TS" funnel status 2>&1); echo "funnel_on=$(echo "$F" | grep -c '(Funnel on)') root_8793=$(echo "$F" | grep -cE '^\|-- +/ +proxy +http://(127\.0\.0\.1|localhost):8793$') purchase_8794=$(echo "$F" | grep -cE '^\|-- +/purchase +proxy +http://(127\.0\.0\.1|localhost):8794/purchase$')")"
} >> "$DATA/logs/deploy-evidence.txt"
{ "$TS" funnel status 2>&1; echo ---; "$TS" serve status 2>&1; } | sed -E 's#https?://[^ /]+#https://<funnel 主機>#g' > "$DATA/logs/funnel-before.txt"
cat "$DATA/logs/funnel-before.txt"
```

---

## 第 1 步：Node【Claude】（沿用佈告欄的 `~/.local/node`，已有就不重裝）

```sh
export PATH="$HOME/.local/node/bin:$PATH"; NODE="$HOME/.local/node/bin/node"
"$NODE" -v && "$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')"
```

期望 `v24.x.y`、`node:sqlite OK` → 這一步結束。**不要升級、不要換捷徑**（佈告欄與貨單共用這個 Node，小版升級由 Eason 另外決定）。`~/.local/node` 不存在或不是 24：**停**，照 `~/dzy-bulletin/server/DEPLOY.md` 第 1 步安裝後再回來。

---

## 第 2 步：程式、資料夾與 `.env` 骨架【Claude】

repo 是 public，**不需要登入**。**部署一律用分支 `macmini-backend`**（部署在切換前，此時 `main` 還沒有 `server/`，也刻意不先併 main——併了會讓店員提早看到設定頁入口；Eason 另外指定分支才改）。切換完成（`CUTOVER.md` 第 5 步把 `macmini-backend` 併進 `main`）之後，Mac mini 的更新改從 `main` pull：`git -C "$REPO" checkout main && git pull --ff-only`。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"
BRANCH="macmini-backend"                                     # 切換完成後的更新才改成 main；以 Eason 說的為準
if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q origin && git -C "$REPO" checkout -q "$BRANCH" && git -C "$REPO" pull -q --ff-only; else git clone -q -b "$BRANCH" https://github.com/Eason0728/mala-cashbook.git "$REPO"; fi
git -C "$REPO" log --oneline -1; ls "$REPO/server/index.js" "$REPO/server/launchd"
mkdir -p "$DATA/logs" && chmod 700 "$DATA"                  # logs 一定要先建：launchd 開不了 log 檔就不會啟動
echo "程式：$(git -C "$REPO" branch --show-current) $(git -C "$REPO" rev-parse --short HEAD)／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"
git -C "$REPO" check-ignore -q server/.env && echo "server/.env 已被 git 忽略" || echo "✗ .gitignore 沒有 server/.env，停下來回報"
( cd "$REPO" && "$NODE" --test server/test/ 2>&1 | grep -E '^ℹ (tests|pass|fail)' )    # 期望 fail 0（在 mini 實際的 Node 上跑一遍）
```

建 `.env` 骨架——**只寫非祕密行**（`PUBLIC_BASE` 從 Tailscale 的主機名取、直接寫進檔案不印出；`LOG_XFF=1` 是第 7 步實測用，實測完會拿掉）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
test -e "$REPO/server/.env" && { echo "✗ .env 已存在，不要覆蓋，回報 Eason"; exit 1; }
H=$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
( umask 077
  printf 'PORT=8795\nDATA_DIR=%s\n' "$DATA" > "$REPO/server/.env"
  printf 'BACKUP_URL=%s\n' 'https://script.google.com/macros/s/AKfycbwYrujemCtWRps8oy9wD2j0i4eHAjntmINuveD1Sm16QdyzDNXYE5vMrLueGhI5J-7ERw/exec' >> "$REPO/server/.env"
  printf 'PUBLIC_BASE=https://%s/cashbook\n' "$H" >> "$REPO/server/.env"
  printf 'LOG_XFF=1\n' >> "$REPO/server/.env" )
unset H; chmod 600 "$REPO/server/.env"
grep -c '^PUBLIC_BASE=https://[^/]*/cashbook$' "$REPO/server/.env"      # 期望 1
grep -c '^BACKUP_URL=https://.*/exec$' "$REPO/server/.env"              # 期望 1
```

- `ADMIN_INIT`、`PNL_KEY`、`BACKUP_KEY` 三行**不在這裡寫**，由 Eason 在第 3 步自己加。
- **不得**有 `ALLOW_ORIGIN`（預設已含正式前端網域 `https://eason0728.github.io`）。
- 沒有 `ADMIN_INIT` 時伺服器仍能起來，只是設定頁登不進去、`adminSave` 不能用；第 3 步補上後要重起。

---

## 第 3 步：【Eason｜第一批，部署前】一次做完

Claude 把下面 B1～B3 整段貼給 Eason。Eason **用他自己開的「終端機」App**（不是 Claude 對話框）做完，說「做完了」後 Claude 跑本節最後的「驗證」。

**B1　寫入三個祕密**（金鑰只存在 shell 變數、寫進 `.env`；指令只印數字，`1`＝成功）：

```sh
E="$HOME/mala-cashbook/server/.env"
# ① BACKUP_KEY：自產，寫進 .env 並放進剪貼簿（畫面上不會出現）
K=$(openssl rand -hex 32); sed -i '' '/^BACKUP_KEY=/d' "$E"; printf 'BACKUP_KEY=%s\n' "$K" >> "$E"; printf '%s' "$K" | pbcopy; unset K; grep -cE '^BACKUP_KEY=[0-9a-f]{64}$' "$E"
```

1. 貼上並執行（印 `1`）。**這之間不要再從對話複製任何東西。**
2. 到備份 Apps Script（dingzhaoyuan5678 帳號那個「現金收支備份」專案）→ 專案設定 → 指令碼屬性 → 新增 `BACKUP_KEY`，⌘V 貼上 → 儲存。（若專案還沒跑過 `setup()`：編輯器選 `setup` → 執行並授權；部署為網頁應用程式的 `/exec` 網址已在 `.env` 的 `BACKUP_URL`。）
3. 回終端機清空剪貼簿：`pbcopy < /dev/null`。
4. 印的不是 `1`：整行重跑（會先刪舊行），再重做第 2～3 點。
5. **目視核對備份網址**：Apps Script「管理部署作業」看現行網頁應用程式部署的 ID，**前 10 碼**要與 `.env` 的 `BACKUP_URL` 一致（`.env` 裡那段 `/macros/s/` 後面的前 10 碼，由 Eason 自己在終端機 `sed -n 's#^BACKUP_URL=.*/macros/s/\(.\{10\}\).*#\1#p' "$HOME/mala-cashbook/server/.env"` 取得）。只回報「一致」或「不一致」；不一致就請 Claude 補寫正確的 `BACKUP_URL`（把 sed 刪舊行再 printf 新行，網址由 Eason 貼給 Claude——部署網址不是祕密）。

```sh
# ② ADMIN_INIT：Eason 自己想一組管理通行碼（至少 4 碼；會計進「設定」頁用）。輸入時不回顯
E="$HOME/mala-cashbook/server/.env"; read -rs "A?管理通行碼初始值：" A; echo; sed -i '' '/^ADMIN_INIT=/d' "$E"; printf 'ADMIN_INIT=%s\n' "$A" >> "$E"; unset A; grep -c '^ADMIN_INIT=.\{4,\}$' "$E"
# ③ PNL_KEY：沿用舊 Apps Script 指令碼屬性 PNL_KEY 的同一把（損益連接器那邊的金鑰就不用換，只換網址）。輸入時不回顯
E="$HOME/mala-cashbook/server/.env"; read -rs "P?PNL_KEY（與舊 Apps Script 同一把）：" P; echo; sed -i '' '/^PNL_KEY=/d' "$E"; printf 'PNL_KEY=%s\n' "$P" >> "$E"; unset P; grep -c '^PNL_KEY=.\{16,\}$' "$E"
```

（zsh 的 `read -rs "A?提示："` 語法；兩行都要印 `1`。）**`ADMIN_INIT` 只在資料庫還沒有管理碼時寫入一次**，之後改管理通行碼要到設定頁改，不是改這行。

**B2　Claude Code 的 `.env` 禁止讀取規則**（技術保險；會合併進 `~/.claude/settings.json`，已有的設定不動）：

```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.claude/settings.json'); os.makedirs(os.path.dirname(p), exist_ok=True)
d = json.load(open(p)) if os.path.exists(p) else {}
deny = d.setdefault('permissions', {}).setdefault('deny', [])
for r in ["Read(~/mala-cashbook/server/.env)", "Read(~/mala-cashbook/server/.env*)", "Edit(~/mala-cashbook/server/.env)"]:
    if r not in deny: deny.append(r)
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2); print('OK')
EOF
```

做完把 Claude 關掉（確保新規則生效），在**同一個資料夾**打 `claude --continue`，說「繼續照 server/DEPLOY.md 第 3 步的驗證」。

**B3　目視確認**：Tailscale 管理後台這台機器的 key expiry 已停用、Funnel 仍開著（佈告欄上線時已做過）。回覆「B3 已確認」。

**驗證（Claude 在 Eason 說做完之後跑；只印數字）：**

```sh
REPO="$HOME/mala-cashbook"
git -C "$REPO" status --porcelain | wc -l                                  # 期望 0（repo 沒被改、.env 被 git 忽略）
python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/settings.json'))); print(sum('mala-cashbook/server/.env' in r for r in d['permissions']['deny']))"   # 期望 ≥ 2
```

`.env` 的檢查交給 Eason（B2 生效後一律由 Eason 在終端機執行，見禁令第 5 條）：請他執行下面這段、**只回報數字與權限欄**：

```sh
E="$HOME/mala-cashbook/server/.env"; ls -l "$E" | cut -c1-10; for k in ADMIN_INIT PNL_KEY BACKUP_KEY BACKUP_URL PUBLIC_BASE; do printf '%s=%s ' $k "$(grep -c "^$k=.\{4,\}$" "$E")"; done; echo; git -C "$HOME/mala-cashbook" status --porcelain | grep -c '\.env'
```

期望：`-rw-------`、五個變數都是 `=1`、最後一個數字 `0`。Claude 把 Eason 回報的結果寫進證據檔（註明「Eason 在終端機執行」）。

---

## 第 4 步：前景試跑【Claude】（還不交給 launchd）

用正式設定起一次，確認 Node、`.env`、資料夾都對。**只關自己起的那個 PID**。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"; PORT=8795
lsof -nP -iTCP:$PORT -sTCP:LISTEN && { echo "✗ $PORT 有人在聽，停下來回報"; exit 1; }
"$NODE" "$REPO/server/index.js" > "$DATA/logs/manual-run.log" 2>&1 &
echo $! > "$DATA/logs/manual-run.pid"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$PORT/cashbook/health"; echo
```

（`index.js` 用自己的位置找 `.env`，不需要先 `cd`。）期望 JSON 有 `"level":"green"`、`"rows":0`（全新空庫剛建好應該是 green；建庫超過 26 小時還沒備份才會轉紅 `BACKUP_STALE`）。再驗：

```sh
DATA="$HOME/mala-cashbook-data"; PORT=8795
lsof -nP -iTCP:$PORT -sTCP:LISTEN                                                         # 期望只有一行 127.0.0.1:8795
[ "$(lsof -t -iTCP:$PORT -sTCP:LISTEN)" = "$(cat "$DATA/logs/manual-run.pid")" ] && echo "聽 $PORT 的就是剛起的 node" || echo "✗ PID 不符，停下來回報"
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/cashbook/nope"           # 期望 404
curl -s -X POST "http://127.0.0.1:$PORT/cashbook/api" -H 'Content-Type: text/plain' -d '{"action":"bootstrap","pass":"x"}'; echo   # 期望 {"ok":false,"error":"AUTH_FAIL"}（HTTP 200）
ls "$DATA"                                                                                # 期望有 cashbook.db（第一次啟動自動建表）
kill "$(cat "$DATA/logs/manual-run.pid")" && rm "$DATA/logs/manual-run.pid"
lsof -nP -iTCP:$PORT -sTCP:LISTEN || echo "$PORT 已釋放"                                   # 期望「已釋放」；還看得到就隔幾秒再跑，仍在就停下來回報
```

啟動訊息出現 `PUBLIC_BASE 未設定` → `.env` 那行沒寫成，回第 2 步。出現 node:sqlite 相關錯誤 → Node 不是 24。（`ExperimentalWarning: SQLite is an experimental feature` 是正常提示。）

---

## 第 5 步：安裝兩個 LaunchDaemon（路線 D）

| Label | 做什麼 | 排程 |
|---|---|---|
| `com.mala.cashbook` | 伺服器本體（埠 8795） | 開機即啟動、`KeepAlive`、當掉 10 秒內重起 |
| `com.mala.cashbook.backup` | 每日備份（`server/backup.js`） | 每天 03:50（台北時間；錯過的班醒來後補跑） |

範本在 `server/launchd/`，佔位字串 `__NODE__`／`__REPO__`／`__DATA_DIR__`。

**【Claude】（不用 sudo）產生 plist**，再用 `plutil` 在**最外層**加 `UserName`（以部署帳號身分執行，資料夾權限才對；不要用 `sed` 加欄位——plist 裡有多個 `<dict>`，會插錯層）：

```sh
lsof -nP -iTCP:8795 -sTCP:LISTEN && { echo "✗ 8795 還有人在聽，先處理"; exit 1; }
REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"; S="$HOME/.local/src/launchdaemons"
mkdir -p "$S"
for j in com.mala.cashbook com.mala.cashbook.backup; do
  sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__DATA_DIR__#$DATA#g" "$REPO/server/launchd/$j.plist" > "$S/$j.plist"
  plutil -insert UserName -string "$(whoami)" "$S/$j.plist"
done
plutil -lint "$S/com.mala.cashbook.plist" "$S/com.mala.cashbook.backup.plist"      # 兩個都要 OK
grep -c '__[A-Z_]*__' "$S"/com.mala.cashbook*.plist                                  # 兩個都要 0
plutil -extract UserName raw "$S/com.mala.cashbook.plist"                            # 期望 = whoami
grep -l '<key>\(ADMIN_INIT\|PNL_KEY\|BACKUP_KEY\|BACKUP_URL\)' "$S"/com.mala.cashbook*.plist || echo "plist 不含祕密設定（正確）"
```

**【Eason】（sudo，在他自己的終端機 App）安裝與載入：**

```sh
S="$HOME/.local/src/launchdaemons"
for j in com.mala.cashbook com.mala.cashbook.backup; do sudo cp "$S/$j.plist" /Library/LaunchDaemons/ && sudo chown root:wheel /Library/LaunchDaemons/$j.plist && sudo chmod 644 /Library/LaunchDaemons/$j.plist; done
for j in com.mala.cashbook com.mala.cashbook.backup; do sudo launchctl bootstrap system /Library/LaunchDaemons/$j.plist; done
```

**驗證【Claude】**（路線 D 不需 sudo 的方式；`launchctl print system/…` 不加 sudo 多半讀不到，**不要拿它當判準**）：

```sh
DATA="$HOME/mala-cashbook-data"
curl -sf --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:8795/cashbook/health; echo
SP=$(lsof -t -iTCP:8795 -sTCP:LISTEN); echo "PID=$SP"
ps -o user=,comm= -p "$SP"                                  # 期望：使用者＝whoami、comm 是 node
pgrep -f "mala-cashbook/server/index.js" | grep -qx "$SP" && echo "✓ 聽 8795 的就是 server/index.js 的程序" || echo "✗ PID 不符，停下來看故障排除 A"
```

另請 **Eason 加 sudo 跑**並回報：`sudo launchctl print system/com.mala.cashbook | grep -E '^\s*(state|pid|last exit code) ='`、`sudo launchctl print system/com.mala.cashbook.backup | grep -E 'state|run interval'`。期望伺服器在跑、backup 是 `not running`（等 03:50）。

**殺掉會自己重起**（驗收：10 秒內；伺服器以部署帳號身分執行，自己的程序可以 kill）：

```sh
DATA="$HOME/mala-cashbook-data"
P1=$(lsof -t -iTCP:8795 -sTCP:LISTEN); echo "原 PID $P1"
T0=$(date +%s); kill "$P1"
curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8795/cashbook/health && SEC=$(( $(date +%s) - T0 )) && echo "已恢復，約 $SEC 秒"
P2=$(lsof -t -iTCP:8795 -sTCP:LISTEN); echo "新 PID $P2"        # 要和原 PID 不同；秒數 ≤ 10
echo "第 5 步 殺掉 node 後重起：${SEC:-失敗} 秒（原 PID $P1 → 新 PID $P2）／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"
```

**既有服務沒被動到**（這一步開始，每做完一個大步驟都再看一次）：印「既有服務基準」六個值，要和第 0 步相同。

---

## 第 6 步：Tailscale Funnel 路徑分流【Claude】（`/cashbook` → 127.0.0.1:8795；**根路徑 `/` 與 `/purchase` 不動**）

這是整份手冊唯一會碰到對外網址的地方。**先確認、再改、改完立刻對照既有服務基準，不一致就回退。**

**⛔ 一定用 `funnel`，不可用 `serve`**：Tailscale 的 `serve` 子命令設定路徑時會把同主機 443 的 Funnel 旗標關掉（`Removing Funnel for …`），結果 `/`、`/purchase`、`/cashbook` 都還在設定裡、但 443 不再對外，**手機 4G 打佈告欄與貨單立刻斷**，本機埠的 `/health` 卻照樣正常（所以基準一定要有 `funnel_on`）。`funnel` 子命令對同一主機只會把 Funnel 設成開，不會動既有路徑。

**前置**：第 0 步的版本與 `--help` 輸出已貼給 Eason、他已確認可以做第 6 步（`funnel --help` 有 `--set-path`）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/mala-cashbook-data"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
cat "$DATA/logs/funnel-before.txt"                           # 第 0 步存的現況（網址已遮蔽）：只該有 / 與 /purchase 兩條
"$TS" funnel --bg --set-path /cashbook "http://127.0.0.1:8795/cashbook"; echo "結束碼 $?"
```

- **目標網址要帶 `/cashbook`**：Tailscale 轉送時會把掛載路徑剝掉，不補回去的話，伺服器收到的是 `/health`（回 404）而不是 `/cashbook/health`。
- 這一行**只新增 `/cashbook` 這一條**。CLI 印出同意連結並一直等：把連結交給 Eason；非 0 結束碼：**停**，把輸出（先遮掉網址）交給 Eason。
- **立刻**對照（不要先做別的）：印第 0 步同一組「既有服務基準」六個值，再印 `"$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<funnel 主機>#g'`。

期望：
1. 六個既有服務基準值與第 0 步**完全一致**（特別是 `funnel_on=1 root_8793=1 purchase_8794=1`）；
2. `funnel status` 看得到三條：`/ → 8793`、`/purchase → 8794/purchase`（與 `funnel-before.txt` 一樣）與 `/cashbook → proxy http://127.0.0.1:8795/cashbook`，主機那行仍有 `(Funnel on)`。

**不一致或既有路徑被改到＝立刻回退**（不要先查原因）。`off` 在同一埠還有其他掛載時 Tailscale 可能**互動式確認**，Claude 的 Bash 不是 TTY 會卡住。依第 0 步 `--help` 的結果二選一：

- **有 `--yes`**：Claude 執行 `"$TS" funnel --https=443 --set-path /cashbook --yes off`（只移除 `/cashbook`），再印 `funnel status`，要回到和 `funnel-before.txt` 一樣。
- **沒有 `--yes`**：**請 Eason 在他自己的終端機 App 手動執行** `tailscale funnel --https=443 --set-path /cashbook off`（CLI 路徑照 `TS`），出現確認答 `y`；做完回報 `funnel status` 與六個基準值。

回退後再印一次基準。仍與 `funnel-before.txt` 不同（既有路徑被改了）→ **停下來回報 Eason**，由他決定是否照佈告欄／貨單手冊的原指令整份重做（`funnel reset` 會動既有對外入口，Claude 不自己做）。

**從 tailnet 外面驗證**（向公開 DNS 查名稱、強迫連公開 IP）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
H=$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')      # 只放在 shell 變數、不寫檔
IP=$(dig +short "$H" @1.1.1.1 | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
case "$IP" in
  "")    echo "✗ 公開 DNS 查不到 IPv4";;
  100.*) echo "✗ 拿到 tailnet 內部位址，不是公開入口";;
  *)     for p in /cashbook/health /purchase/api/health /health; do echo "== $p"; curl -s --max-time 20 --resolve "$H:443:$IP" "https://$H$p" | head -c 200; echo; done;;
esac
```

- 期望三個都回 `{"ok":true,…}` 或本系統的 `{"level":"green",…}`。**現金帳回 404＝路徑前綴被剝掉了**：確認 `/cashbook` 那條目標網址有帶 `/cashbook`（`funnel status` 看得到），沒帶就用 `funnel --bg --set-path …` 重設一次（**不可用 `serve`**）。佈告欄與貨單那兩條回的東西要和第 0 步一致，否則**立刻回退**。
- 這條路是 Mac mini 自己連公開入口再繞回來（hairpin），實機上不一定通：10 分鐘內查不到或不通，**不算失敗**，記「繞回驗證不適用」，以第 8 步手機 4G 為準；但若 `funnel status` 與基準有任何不一致，不管繞回通不通都要回退。
- 結果落檔：`echo "第 6 步 Funnel /cashbook 分流：既有服務基準前後一致；tailnet 外驗證：<通過／繞回驗證不適用>（$(date '+%F %T')）" >> "$HOME/mala-cashbook-data/logs/deploy-evidence.txt"`。

**Funnel 主機網址（`https://` 加 `$H`）只在對話裡交給 Eason**（CUTOVER 第 5 步前端要用）；Mac mini 的任何檔案（除 `.env` 的 `PUBLIC_BASE`）、證據檔、issue 都不寫。

---

## 第 7 步：實測 Funnel 有沒有帶 `X-Forwarded-For`【Claude 做，Eason 在手機上打一下】

為什麼要測：通行碼錯誤計數是「同一來源 10 分鐘錯 20 次 → 鎖 10 分鐘」。`server/index.js` 只在直連的是本機（Funnel）時才信 `X-Forwarded-For`、取最後一段當來源。**如果 Funnel 沒帶這個標頭，全店所有人共用同一個來源**（都是 127.0.0.1），一個人連錯 20 次會把大家都鎖住 10 分鐘。第 2 步已在 `.env` 開了 `LOG_XFF=1`，access log 每行最後會多一個 `xff=<段數>`（只記段數，不記 IP）。

1. **【Eason】** 用手機（關 Wi-Fi、走 4G）打開 `https://<funnel 主機>/cashbook/health`（第 6 步交給他的網址）；再打一次，共兩次。
2. **【Claude】** 看 access log：

```sh
DATA="$HOME/mala-cashbook-data"
grep ' health ' "$DATA/logs/server.log" | tail -n 5                 # 每行結尾有 xff=N；本機 curl 那幾行是 xff=0
```

判讀：
- 手機那幾行 `xff=1`（或更大）＝**Funnel 有帶**。通行碼鎖是依每個來源 IP 分開計，正常。
- 手機那幾行 `xff=0`＝**Funnel 沒帶**。全店共用一個失敗計數：**不用擋部署**，但要記進證據檔與回報，並告知 Eason「有人連錯 20 次會鎖全店 10 分鐘，店長若被鎖請等 10 分鐘」（要改善需改程式，另開 issue，不在本次）。
- 沒看到手機那幾行：手機沒走到 Funnel（還連著 Wi-Fi／Tailscale），請 Eason 重打。

3. **【Claude】** 把結果落檔，然後**拿掉 `LOG_XFF=1`**（它只該在實測時開）。`.env` 不能用 Read／Edit，改用一行 `sed`（只刪這一行，不印內容）：

```sh
REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"
echo "第 7 步 Funnel X-Forwarded-For 實測：<有帶 xff=N／沒帶 xff=0>（$(date '+%F %T')）" >> "$DATA/logs/deploy-evidence.txt"    # 把尖括號換成實測結果
sed -i '' '/^LOG_XFF=/d' "$REPO/server/.env"; grep -c '^LOG_XFF=' "$REPO/server/.env"           # 期望 0
P1=$(lsof -t -iTCP:8795 -sTCP:LISTEN); kill "$P1"; curl -sf --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null http://127.0.0.1:8795/cashbook/health && echo "已重起（新 PID $(lsof -t -iTCP:8795 -sTCP:LISTEN)，原 $P1）"
```

---

## 第 8 步：備份試跑、重開機測試、收尾

**8-1【Claude】手動跑一次備份**（直接執行，`.env` 由程式自己讀）：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; DATA="$HOME/mala-cashbook-data"; NODE="$HOME/.local/node/bin/node"
DATA_DIR="$DATA" "$NODE" "$REPO/server/backup.js" > "$DATA/logs/backup-manual.log" 2>&1; echo "結束碼 $?"; grep -v Warning "$DATA/logs/backup-manual.log"
curl -s http://127.0.0.1:8795/cashbook/health; echo
echo "第 8 步 備份試跑：結束碼 <N>／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"
```

期望：印「備份成功」、結束碼 `0`、`/health` 為 `green` 且 `backupAt` 有值。空庫備份只送表頭（rows 0）。失敗見故障排除 E。

**8-2【Eason】重開機測試**（照貨單 V5／V6，FileVault 流程）：重開（或拔電再插）→ 在解鎖畫面輸入部署帳號的密碼 → **解鎖後不必做任何事，等 3 分鐘** → 手機（4G）打 `https://<funnel 主機>/cashbook/health`、`/health`（佈告欄）、`/purchase/api/health`（貨單），三個都要正常。回報結果。

**8-3【Claude】重開機後確認**：

```sh
DATA="$HOME/mala-cashbook-data"; uptime
curl -s http://127.0.0.1:8795/cashbook/health; echo
tail -n 3 "$DATA/logs/server.log"
```

印「既有服務基準」六個值（要和第 0 步一致）。三項都正常 → 寫進證據檔：`echo "第 8 步 重開機測試通過／$(date '+%F %T')" >> "$DATA/logs/deploy-evidence.txt"`。

**8-4【Claude】收尾檢查**（不碰 `.env`）：

```sh
REPO="$HOME/mala-cashbook"
git -C "$REPO" grep -l "guo""eason" | wc -l                 # 期望 0（字串拆兩半免得這行自己被搜到）
git -C "$REPO" grep -IEn '[a-z0-9-]+\.tail[0-9a-z]+\.ts\.net' | wc -l     # 期望 0：repo 內沒有真實 Funnel 主機名（只抓真實形態；說明文字裡的 <mini>.ts.net 等佔位字串不算）
git -C "$REPO" status --porcelain                           # 期望空白
lsof -nP -iTCP:8795 -sTCP:LISTEN; lsof -nP -iTCP:8794 -sTCP:LISTEN; lsof -nP -iTCP:8793 -sTCP:LISTEN     # 各只有一行 127.0.0.1
ls /Library/LaunchDaemons/com.dzy.* /Library/LaunchDaemons/com.mala.cashbook* 2>/dev/null     # 既有的 job 還在、沒被動到
```

**金鑰外洩檢查交給 Eason**（只回報數字；取 `BACKUP_KEY` 前 8 碼比對 Claude 的對話紀錄與伺服器 log，不印金鑰）：

```sh
E="$HOME/mala-cashbook/server/.env"; DATA="$HOME/mala-cashbook-data"
[ "$(grep -cE '^BACKUP_KEY=[0-9a-f]{64}$' "$E")" = 1 ] && grep -rlF "$(sed -n 's/^BACKUP_KEY=//p' "$E" | cut -c1-8)" ~/.claude/projects/ "$DATA/logs" 2>/dev/null | wc -l
```

回 `0`＝沒外洩。非 0 → **不要打開命中的檔案**，Eason 重做 B1 的 `BACKUP_KEY`（Apps Script 屬性＋`.env`），重起伺服器。

**部署完成回報**（Claude 貼給 Eason，不含網址與金鑰）：Node 版本、repo 分支與 commit、第 5 步重起秒數、既有服務基準前後對照、XFF 實測結果、備份試跑結果、重開機測試結果、`/cashbook/health` 內容。**到這裡部署完成，資料庫是空的、前端還指向舊 Apps Script**——下一步看 `CUTOVER.md`。

---

## 部署中途更新（程式有新版、Mac mini 已在跑）

更新前先備份資料庫（`cp "$DATA/cashbook.db" "$DATA/cashbook.db.before-update"`）。

```sh
export PATH="$HOME/.local/node/bin:$PATH"; REPO="$HOME/mala-cashbook"; NODE="$HOME/.local/node/bin/node"
git -C "$REPO" pull --ff-only && ( cd "$REPO" && "$NODE" --test server/test/ 2>&1 | grep -E '^ℹ (pass|fail)' )
P1=$(lsof -t -iTCP:8795 -sTCP:LISTEN); kill "$P1"     # 由 KeepAlive 在 10 秒內重起；伺服器只在啟動時讀 .env 與程式
curl -sf --retry 30 --retry-delay 1 --retry-connrefused http://127.0.0.1:8795/cashbook/health; echo "新 PID $(lsof -t -iTCP:8795 -sTCP:LISTEN)（原 $P1）"
```

沒有新依賴（只用 Node 內建模組），不需要 `npm ci`。改了 plist 要由 Eason `sudo launchctl bootout system/<label>` 再 `sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist`（`kickstart` 不會重讀 plist）。

---

## 故障排除

以下指令的變數沿用「手冊約定」那一行。

**A. launchd 起不來（`/cashbook/health` 打不通）**
- 看 log（不含金鑰）：`tail -30 "$DATA/logs/server.err.log"`；Eason 加 sudo：`sudo launchctl print system/com.mala.cashbook | grep -E 'last exit code|state'`。
- `bootstrap` 回 `Bootstrap failed: 5: Input/output error`：通常是已經載入過了。Eason 先 `sudo launchctl bootout system/<label>` 再 bootstrap。
- 完全沒有 log 檔、`last exit code = 78`：`$DATA/logs` 不存在 → `mkdir -p "$DATA/logs"`，再檢查 plist 路徑（`plutil -p /Library/LaunchDaemons/com.mala.cashbook.plist`）。
- `Operation not permitted`：repo 或資料夾放在桌面／文件／下載底下 → 搬到 `$HOME` 底下，重做第 5 步。
- 啟動訊息 `PUBLIC_BASE 未設定`：`.env` 沒有那一行 → Claude 補寫（非祕密行）後 kill PID 讓 KeepAlive 重起。
- node:sqlite 錯誤：plist 的 `__NODE__` 指錯 → `"$HOME/.local/node/bin/node" -v`。
- `EADDRINUSE`：8795 被別的程序占住（常見是第 4 步前景試跑沒關乾淨）。`lsof -nP -iTCP:8795 -sTCP:LISTEN` 看是誰；是自己起的才 kill，不是就停下來回報。

**B. Funnel／路徑分流**
- 現金帳 404、佈告欄與貨單正常 → `/cashbook` 那條目標網址沒帶 `/cashbook`，用 `funnel --bg --set-path /cashbook "http://127.0.0.1:8795/cashbook"` 重設（**不可用 `serve`**）。
- 佈告欄或貨單不正常（含 `funnel_on` 變了）→ **立刻回退第 6 步**，再查原因。
- `tailscale status` 顯示 Logged out／Stopped、key expiry → 照 `~/dzy-bulletin/server/DEPLOY.md` 的故障排除；**本系統不另外處理 Tailscale**。
- 剛設好時 TLS 錯誤或公開 DNS 查不到 → 憑證與 DNS 還在生效，10 分鐘內再試。

**C. 三個服務互相影響**
- 兩兩獨立：埠（8793／8794／8795）、launchd 名稱、資料夾、`.env` 都分開。重起、更新一邊**不需要**動其他。
- 共用的只有 `~/.local/node`（Node 24）、Tailscale、Funnel 的 443。升級 Node 小版會同時影響三邊，由 Eason 挑時間做、做完三邊都要重起並看 `/health`。

**D. `/cashbook/health` 黃紅燈**
- 紅 `BACKUP_STALE`（上次成功備份超過 26 小時；剛部署還沒跑過備份時，建庫 26 小時後也會）→ 看 `$DATA/logs/backup.err.log` 與 `backup.out.log`，手動跑一次（8-1）看錯誤。
- 紅 `DISK_LOW`（剩不到 2 GB）→ 清磁碟；`$DATA/snapshots` 只留 14 天，`$DATA/photos` 不要刪。
- 黃 `PHOTOS_PENDING`（照片待備份超過 200 張）→ 備份單次最多補傳 50 張，連續幾天會自己清完；一直不減就看備份錯誤。
- 黃 `BACKUP_FAILED`（最近一次失敗但上次成功還在 26 小時內）→ 同 E。

**E. 備份**
- 輸出「BACKUP_URL 或 BACKUP_KEY 沒設」→ `.env` 兩行沒填或格式錯（交給 Eason 在終端機用第 3 步的檢查指令確認）。
- 錯誤含「備份端回報 AUTH」→ 兩邊金鑰不一致：Eason 重做 B1 ①（Apps Script 屬性＋`.env`）。備份端連錯 20 次會鎖 10 分鐘，等一下再試。
- 錯誤含「非 JSON」→ `BACKUP_URL` 不是網頁應用程式的 `/exec` 網址，或部署的存取權不是「所有人」。
- 03:50 沒跑：`sudo launchctl print system/com.mala.cashbook.backup | grep -E 'state|last exit'`；機器睡眠時錯過的班會在喚醒後補跑。

**F. 通行碼被鎖**
- 症狀：店長輸入正確通行碼也回「錯誤次數過多」。原因：同一來源 10 分鐘內錯 20 次（若第 7 步實測 Funnel 沒帶 XFF，來源是全店共用的一個）。等 10 分鐘自動解除；鎖定計數在記憶體，**重起伺服器就會清掉**，但不建議為此重起；等 10 分鐘即可。

---

## 回退（整套拆掉）

只拆本系統，**佈告欄與貨單不動**：

```sh
export PATH="$HOME/.local/node/bin:$PATH"; DATA="$HOME/mala-cashbook-data"
TS=$( [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && echo /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale )
# ① 先拆 Funnel 路徑：有 --yes 才由 Claude 執行；沒有 --yes 請 Eason 在終端機手動執行
"$TS" funnel --https=443 --set-path /cashbook --yes off                              # 沒有 --yes 時改由 Eason：tailscale funnel --https=443 --set-path /cashbook off
"$TS" funnel status 2>&1 | sed -E 's#https?://[^ /]+#https://<funnel 主機>#g'          # 要與 funnel-before.txt 相同
# ② Eason（sudo）：for j in com.mala.cashbook com.mala.cashbook.backup; do sudo launchctl bootout system/$j; sudo rm /Library/LaunchDaemons/$j.plist; done
# ③ 再印「既有服務基準」六個值，要與第 0 步相同
```

**`~/mala-cashbook-data`（含 `cashbook.db` 與全部收據照片）不要刪**——除非 Eason 明確說要刪；資料沒備份前不要動。這是「拆掉部署」；**已經切換過、要把前端與資料退回舊 Apps Script** 是另一件事，見 [`ROLLBACK.md`](ROLLBACK.md)。
