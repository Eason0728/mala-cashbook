# 操作圖解（給店長的說明頁）

線上版：<https://claude.ai/code/artifact/1ee19655-542c-446f-8357-71d75f8e8d19>
**改版一律 republish 同一個 URL**，不要另外發一份——店長手上的連結只有這一個。

## 畫面或流程改了要怎麼重出

```bash
python3 e2e/guide/data.py > /tmp/guide_data.json   # 示範資料（光復店、假金額）
python3 e2e/guide/shoot.py                          # 截圖到 e2e/guide/s*.png
python3 e2e/guide/crop.py                           # 裁切＋轉 base64 → /tmp/guide_imgs.json
# 把 template.html 的 {{名稱}} 換成 base64，產出單檔 HTML，再用 Artifact 發布同一個 URL
```

截圖一律跑 `?mode=local` 並注入假資料——**說明頁上不能出現真實帳目**。

## 檔案

- `data.py`　　示範資料（新竹光復、7 筆，廠商與金額都是編的）
- `shoot.py`　 Playwright 截 7 張整頁圖
- `crop.py`　　裁成聚焦片段、壓成 JPEG、轉 base64
- `template.html`　圖解頁原稿，圖片位置是 `{{login}}` 這類佔位
- `s*.png`　　最近一次的截圖（可重跑產生，不必手動保管）
