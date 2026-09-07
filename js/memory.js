/* 常用項目記憶：打過的廠商／項目，下次打字就自動帶出來，連科目一起填好。
 *
 * 記憶的方向是「項目名稱 → 科目」，不是反過來——店長看著收據時想到的是廠商名，
 * 不是「食材」。所以表單把項目名稱放在科目上面，科目由記憶推出來。
 *
 * 資料正本在後端「常用項目」分頁（換手機、換人也還在）；
 * localStorage 只是快取，讓畫面在後端回來之前就先有東西可以點。
 */
(function () {
  'use strict';

  var CACHE_KEY = 'cashbook_frequent_v1';
  var MAX_CHIPS = 8;   // 2026-09-08 Eason 拍板：候選固定 8 個，不要更多
  var list = [];

  function load() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) list = JSON.parse(raw) || [];
    } catch (e) { list = []; }
    return list;
  }

  function set(rows) {
    list = (rows || []).slice();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  /* 排序一律用「最後使用時間」而不是「使用次數」——店裡換了廠商之後，
     舊廠商的累積次數還是最高，用次數排會一直把已經不用的東西推到最前面。
     2026-09-08 Eason 確認過這個選擇（「只列最近用過的八個」），不要改成用次數排。 */
  function byRecent(a, b) { return (b.lastUsed || '') < (a.lastUsed || '') ? -1 : 1; }

  function inScope(f, subjects) { return !subjects || subjects.indexOf(f.subject) >= 0; }

  /* 還沒打字時：最近用過的幾個，直接點就好。
     subjects 傳目前收支別的科目清單，避免在「收入」畫面跳出支出的廠商。 */
  function recent(subjects) {
    return list.filter(function (f) { return inScope(f, subjects); })
               .sort(byRecent).slice(0, MAX_CHIPS);
  }

  /* 打字中：名稱含有這段字的候選。空字串就回最近用過的。 */
  function suggest(text, subjects) {
    var q = String(text || '').trim();
    if (!q) return recent(subjects);
    var lower = q.toLowerCase();
    return list.filter(function (f) {
      return inScope(f, subjects) && String(f.name).toLowerCase().indexOf(lower) >= 0;
    }).sort(byRecent).slice(0, MAX_CHIPS);
  }

  /* 這個項目名稱以前用過嗎？用過就回它上次記在哪個科目。
     找不到＝新項目，畫面要提示「沒有歷史紀錄，請自己選科目」。 */
  function subjectOf(name, subjects) {
    var q = String(name || '').trim();
    if (!q) return null;
    var hits = list.filter(function (f) {
      return inScope(f, subjects) && String(f.name).trim() === q;
    }).sort(byRecent);
    return hits.length ? hits[0].subject : null;
  }

  function remember(subject, name) {
    var hit = null;
    list.forEach(function (f) { if (f.subject === subject && f.name === name) hit = f; });
    var now = new Date().toISOString();
    if (hit) { hit.count = (hit.count || 0) + 1; hit.lastUsed = now; }
    else list.push({ subject: subject, name: name, count: 1, lastUsed: now });
    set(list);
  }

  window.Memory = {
    load: load, set: set, remember: remember,
    recent: recent, suggest: suggest, subjectOf: subjectOf
  };
})();
