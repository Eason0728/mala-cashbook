/* ?mode=local 的示範資料：17 筆虛構的收支（15 支出＋2 收入）。
 *
 * 這裡的廠商名與金額**全部是編的**，不是任何一家店的真帳——
 * 這個 repo 是 public（GitHub Pages 免費方案的限制），真實帳目不能進版控。
 * 光復店 9 月的真實 17 筆留在本機 `private/paper-2026-09.real.js`（已 gitignore），
 * 需要拿真資料回測時把它複製成 js/demo-data.js 即可，兩份結構完全一樣。
 *
 * 結構與正式資料一致，所以本機測試看到的畫面、合計、匯出格式都跟上線後一樣。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaperData = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORE = '示範門市';
  var raw = [
    // [日, 收支別, 科目, 項目名稱, 金額]
    [1, '支出', '蔬果', '示範蔬果行—當日青菜', 500],
    [1, '支出', '瓦斯', '示範瓦斯行—1桶', 600],
    [2, '支出', '蔬果', '示範蔬果行—當日青菜', 500],
    [2, '支出', '食材', '示範食品行—冷藏', 400],
    [2, '支出', '食材', '示範食品行—常溫', 800],
    [3, '支出', '房租管理費', '示範大樓—管理費', 450],
    [3, '支出', '瓦斯', '示範瓦斯行—1桶', 600],
    [3, '支出', '食材', '示範食品行—冷藏', 2700],
    [4, '支出', '房租管理費', '示範大樓—管理費', 450],
    [4, '支出', '蔬果', '高麗菜・冬瓜・檸檬 ×4', 1900],
    [6, '支出', '瓦斯', '示範瓦斯行—1桶', 650],
    [7, '支出', '修繕維護', '示範工程行—外裝維修', 900],
    [7, '支出', '瓦斯', '示範瓦斯行—1桶', 650],
    [7, '支出', '食材', '示範食品行—冷藏', 3900],
    [7, '支出', '食材', '示範食品行—常溫', 1800],
    [1, '收入', '員工／同業購買', '同仁購買店販商品', 700],
    [2, '收入', '回收收入', '廚餘—酸桶回收', 1000]
  ];

  var seqCounter = { 支出: 0, 收入: 0 };
  var rows = raw.map(function (r, i) {
    var day = r[0], kind = r[1], amount = r[4];
    var dd = (day < 10 ? '0' : '') + day;
    seqCounter[kind] += 1;
    return {
      id: '2026-09-' + ('00' + (i + 1)).slice(-3),
      store: STORE,
      date: '2026-09-' + dd,
      kind: kind,
      subject: r[2],
      name: r[3],
      amount: amount,
      hasInvoice: false,   // 紙本稅額欄空白＝當作無發票
      net: amount,
      tax: 0,
      seq: seqCounter[kind],
      photo: '',
      author: '店長',
      createdAt: '2026-09-' + dd + 'T10:00:00+08:00',
      status: '正常'
    };
  });

  return { store: STORE, month: '2026-09', rows: rows };
});
