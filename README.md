# 現金收支登記｜麻的小辛辣

門市現金支出與收入明細的手機登記工具，取代紙本「現金支出明細表／現金收入明細表」。
店長當天用手機登記，會計月底匯出 Excel 進帳。

## 使用

- 正式：<https://eason0728.github.io/mala-cashbook/>（需通行碼）
- 試用：網址加上 `?mode=local` 即為本機測試模式，資料只存在自己的瀏覽器，
  不會碰到真試算表，通行碼 `1234`。

加到手機主畫面後會以全螢幕開啟，跟 App 一樣。

## 功能

| | |
|---|---|
| 一筆一送 | 送出後留在原頁，可連續登記；沒送出就離開不留任何資料 |
| 名稱記憶 | 打過的廠商自動帶出科目；新項目會提示沒有歷史紀錄 |
| 稅額自動拆 | 只填金額＋勾有無發票，未稅與稅額由系統算 |
| 送出中計秒 | 每顆按鈕按下顯示經過秒數，逾時 20 秒中止且不自動重送 |
| 刪除留痕 | 沒有實體刪除，只有「作廢」：留在帳上、不計入合計與匯出 |
| 月結鎖定 | 匯出後鎖定該月，不能再新增或修改 |

## 結構

```
index.html            單頁，四個畫面
css/base.css          設計語彙（色票沿用打卡／薪資系統）
js/calc.js            純計算，node 跑得起來，是自動化測試的裁判
js/demo-data.js       本機測試模式的示範資料（虛構，非真帳）
js/api.js             後端呼叫，local／cloud 兩條分支同一組介面
js/views/*.js         login／entry／list／export 四個畫面
apps-script/Code.gs   後端：Google 試算表四個分頁、xlsx 匯出
docs/                 requirements／spec／plan／task 四份文件
test/logic.test.js    node test/logic.test.js → PASS/FAIL
```

## 測試

```bash
node test/logic.test.js
```

## 資料與安全

- 通行碼只存在 Google 試算表的「設定」分頁，**不寫進程式碼、不進這個 repo**。
- 科目清單同樣存在試算表，會計自己改一行就生效，不必改程式。
- `js/demo-data.js` 的廠商名與金額全部是虛構的；真實帳目留在本機 `private/`（已 gitignore）。
