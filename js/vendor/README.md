# 第三方函式庫

## xlsx.mini.min.js

SheetJS Community Edition 0.20.3（`xlsx.mini` 精簡版，276 KB）
來源：<https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js>
授權：Apache License 2.0（檔頭版權聲明必須保留）

**為什麼放在 repo 而不是掛 CDN**：這支 app 會被加到手機主畫面、Service Worker 要能整包
快取離線用；掛 CDN 等於把「會計月底匯不匯得出來」押在第三方站台當下通不通。

**為什麼要它**：匯出原本由後端 Apps Script 建臨時試算表、請 Google 轉檔成 xlsx 再
base64 回傳，常態 20～40 秒（2026-09-09 因此爆過一次逾時）。改由瀏覽器就地產檔後
不到 1 秒，而且完全不依賴後端。

**只用到三個 API**：`utils.aoa_to_sheet` / `utils.book_append_sheet` / `write`。
不解析任何外部檔案（只寫不讀），所以 0.18.x 那個解析端的 prototype pollution CVE 不適用。

升級時：直接換檔、把上面的版本號改掉，然後跑 `/usr/bin/python3 e2e/run.py` 三次不同種子。
