// 【總說明】js/custom-rules.js（前端）：「使用者自訂來源規則」的管理介面與資料層。
// 使用者可以自己新增動畫 / 漫畫的搜尋來源，共兩種規則：
//  - xpath 規則：用 XPath 描述網站結構，由後端 api/custom-rules.js 去抓並解析，結果直接顯示在站內
//  - jump 搜尋跳轉：只存「網站名稱 + 搜尋網址」，點了就在新分頁開啟該網站的搜尋結果
// 這支檔案做的事：
//  1. 儲存：規則存在瀏覽器 localStorage；登入後再同步到伺服器 /api/user/custom-rules（跨裝置）
//  2. 驗證 / 匯入 / 匯出規則 JSON（相容 Kazumi 規則格式）
//  3. 呼叫後端 API（/api/kazumi/custom-*、/api/manga/custom-*）
//  4. 畫出「規則管理」彈出視窗（Bootstrap Modal）與搜尋跳轉按鈕列
//  5. 把功能掛在 window.CustomRules，讓 app.js / acg.js 呼叫（例如取得規則做成播放來源）
// 整支檔案包在 IIFE (立即執行函式) 裡，裡面的變數不會污染全域，只對外公開 window.CustomRules。
/**
 * Web Library - ACG 使用者自訂來源規則
 *
 * 動畫區：
 *   - 進階：Kazumi 規則 (XPath)，可貼上 Kazumi JSON 匯入或逐欄填寫，會和內建來源一起出現在「播放來源」清單
 *   - 簡單：搜尋跳轉 (網站名稱 + 含 @keyword 的搜尋網址)，在來源清單上方一鍵開新分頁
 * 漫畫區：
 *   - 進階：仿 Kazumi 的 XPath 規則 (搜尋 / 章節 / 內頁圖片)，結果直接出現在站內搜尋結果
 *   - 簡單：搜尋跳轉
 *
 * 儲存：localStorage (web_library_custom_rules_v1)，登入帳號時另外同步到 /api/user/custom-rules。
 * 抓取：一律交給後端 (/api/kazumi/custom-*、/api/manga/custom-*)，後端會擋內網位址並限制大小與逾時。
 */
// IIFE：定義後立刻執行，目的是把內部變數藏起來（變數作用域只在這個函式內）。
(function () {
  "use strict";

  // 防止重複載入：頁面可能被多次載入這支腳本，已經初始化過就直接結束。
  if (window.CustomRules) return; // index.html 與 acg.html 都會載入，避免 SPA 換頁重複初始化

  // STORAGE_KEY：localStorage 的鍵名。META_KEYS：規則的「系統欄位」（id、種類、模式…），匯入 / 匯出時要略過，不屬於使用者填的內容。
  const STORAGE_KEY = "web_library_custom_rules_v1";
  const META_KEYS = ["id", "kind", "mode", "enabled", "createdAt", "updatedAt"];

  // 範例規則：使用者按「填入範例」時會填入，讓人照著改。各欄位是 XPath 或網址模板（@keyword 會被換成搜尋關鍵字）。
  // Kazumi 官方規則庫 AGE.json 的格式，方便使用者照著改
  const SAMPLE_ANIME = {
    api: "1",
    type: "anime",
    name: "AGE動漫 (自訂範例)",
    version: "1.0",
    baseURL: "https://www.agedm.io/",
    searchURL: "https://www.agedm.io/search?query=@keyword",
    searchList: "//div[2]/div/section/div/div/div/div",
    searchName: "//div/div[2]/h5/a",
    searchResult: "//div/div[2]/h5/a",
    chapterRoads: "//div[2]/div/section/div/div[2]/div[2]/div[2]/div",
    chapterResult: "//ul/li/a",
  };
  const SAMPLE_MANGA = {
    type: "manga",
    name: "包子漫畫 (自訂範例)",
    baseURL: "https://www.webmota.com/",
    searchURL: "https://www.webmota.com/search?q=@keyword",
    searchList: "//div[contains(@class,'comics-card')]",
    searchName: ".//h3",
    searchResult: "./a/@href",
    searchCover: ".//amp-img",
    chapterList: "//div[@id='chapter-items'] | //div[@id='chapters_other_list']",
    chapterResult: ".//a[contains(@href,'page_direct')]",
    pageImage: "//amp-img[contains(@class,'comic-contain__item')]",
  };
  // 小說範例：維基文庫 (公有領域古典小說，合法)。格式借鑑 Legado 書源的「搜尋 -> 目錄 -> 正文」
  const SAMPLE_NOVEL = {
    type: "novel",
    name: "維基文庫 (自訂範例)",
    baseURL: "https://zh.wikisource.org/",
    searchURL: "https://zh.wikisource.org/w/index.php?search=@keyword&title=Special:%E6%90%9C%E7%B4%A2&ns0=1&fulltext=1",
    searchList: "//ul[@class='mw-search-results']/li",
    searchName: ".//div[@class='mw-search-result-heading']/a",
    searchResult: ".//div[@class='mw-search-result-heading']/a/@href",
    chapterList: "//div[contains(@class,'mw-parser-output')]",
    chapterResult: ".//a[starts-with(@href,'/wiki/') and not(contains(@href,':'))]",
    contentTitle: "//h1",
    contentNode: "//div[contains(@class,'mw-parser-output')]/p",
  };
  // 依種類取範例規則
  function sampleOf(kind) {
    return kind === "anime" ? SAMPLE_ANIME : kind === "novel" ? SAMPLE_NOVEL : SAMPLE_MANGA;
  }

  // FIELDS：編輯表單要顯示哪些欄位。每個欄位是陣列：[欄位名, 顯示標籤, 是否必填, 提示說明, 是否為進階選項]。
  // 鍵名 "動畫:xpath"、"漫畫:xpath"、jump 分別對應三種規則的表單。表單是依這張表動態產生的，要加欄位只要改這裡。
  // 表單欄位定義：[key, 標籤, 是否必填, 說明, 進階]
  const FIELDS = {
    "anime:xpath": [
      ["name", "網站名稱", true, "顯示在來源清單"],
      ["baseURL", "網站首頁", false, "相對連結以此為基準，例如 https://www.agedm.io/"],
      ["searchURL", "搜尋網址", true, "用 @keyword 代表搜尋關鍵字"],
      ["searchList", "搜尋結果列表 searchList", true, "XPath，選出每一筆結果"],
      ["searchName", "標題 searchName", true, "XPath，相對每一筆結果"],
      ["searchResult", "詳情連結 searchResult", true, "XPath，相對每一筆結果，取 href"],
      ["chapterRoads", "播放線路 chapterRoads", true, "XPath，在詳情頁選出每條線路"],
      ["chapterResult", "集數連結 chapterResult", true, "XPath，相對每條線路，取 href"],
      ["userAgent", "User-Agent", false, "留空使用預設瀏覽器 UA", true],
      ["referer", "Referer", false, "留空使用網站首頁", true],
      ["usePost", "搜尋使用 POST", false, "searchURL 的查詢參數改用 POST 表單送出", true],
    ],
    "manga:xpath": [
      ["name", "網站名稱", true, "顯示在搜尋結果的來源標籤"],
      ["baseURL", "網站首頁", false, "相對連結以此為基準"],
      ["searchURL", "搜尋網址", true, "用 @keyword 代表搜尋關鍵字"],
      ["searchList", "搜尋結果列表 searchList", true, "XPath，選出每一筆結果"],
      ["searchName", "標題 searchName", true, "XPath，相對每一筆結果"],
      ["searchResult", "詳情連結 searchResult", true, "XPath，相對每一筆結果，取 href"],
      ["searchCover", "封面圖 searchCover", false, "XPath，相對每一筆結果；留空取第一張 img"],
      ["chapterList", "章節區塊 chapterList", false, "XPath，在詳情頁選出章節容器；留空為整頁"],
      ["chapterResult", "章節連結 chapterResult", true, "XPath，相對章節區塊，取 href"],
      ["pageImage", "內頁圖片 pageImage", false, "XPath，在章節頁選出圖片；留空為 //img"],
      ["referer", "圖片 Referer", false, "防盜鏈用，留空使用章節頁網址", true],
      ["userAgent", "User-Agent", false, "留空使用預設瀏覽器 UA", true],
      ["chapterReverse", "章節倒序", false, "網站把最新章節排在最前面時勾選", true],
      ["usePost", "搜尋使用 POST", false, "", true],
    ],
    "novel:xpath": [
      ["name", "網站名稱", true, "顯示在小說書源按鈕上"],
      ["baseURL", "網站首頁", false, "相對連結以此為基準"],
      ["searchURL", "搜尋網址", true, "用 @keyword 代表搜尋關鍵字"],
      ["searchList", "搜尋結果列表 searchList", true, "XPath，選出每一筆結果"],
      ["searchName", "書名 searchName", true, "XPath，相對每一筆結果"],
      ["searchResult", "詳情連結 searchResult", true, "XPath，相對每一筆結果，取 href"],
      ["searchAuthor", "作者 searchAuthor", false, "XPath，相對每一筆結果"],
      ["searchCover", "封面圖 searchCover", false, "XPath，相對每一筆結果"],
      ["chapterList", "目錄區塊 chapterList", false, "XPath，在詳情頁選出目錄容器；留空為整頁"],
      ["chapterResult", "章節連結 chapterResult", true, "XPath，相對目錄區塊，取 href"],
      ["contentNode", "正文 contentNode", true, "XPath，在章節頁選出正文容器或每一段 <p>；會依 <br> 與段落自動分段"],
      ["contentTitle", "章節標題 contentTitle", false, "XPath，在章節頁取標題；留空用目錄上的章名", true],
      ["referer", "Referer", false, "留空使用網站首頁", true],
      ["userAgent", "User-Agent", false, "留空使用預設瀏覽器 UA", true],
      ["chapterReverse", "目錄倒序", false, "網站把最新章節排在最前面時勾選", true],
      ["usePost", "搜尋使用 POST", false, "", true],
    ],
    jump: [
      ["name", "網站名稱", true, "按鈕上顯示的文字"],
      ["searchURL", "搜尋網址", true, "用 @keyword 代表搜尋關鍵字，例如 https://www.google.com/search?q=@keyword"],
      ["icon", "圖示", false, "Bootstrap Icons 名稱 (如 bi-globe) 或 1~2 個 emoji，選填"],
    ],
  };
  // 布林欄位（勾選框）：值是 true/false，不是文字。
  const BOOL_FIELDS = new Set(["usePost", "chapterReverse"]);

  // 小工具函式。
  // ==================== 工具 ====================
  // esc(str)：HTML 跳脫，把 & < > " ' 換成實體碼。把使用者輸入放進 innerHTML 前一定要用，防止 XSS（腳本注入）。
  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // toast(msg, icon)：顯示提示訊息。優先用全站的 window.showToast，沒有就只印 console。
  function toast(msg, icon) {
    if (typeof window.showToast === "function") window.showToast(msg, icon || "bi-info-circle text-info");
    else console.log("[CustomRules]", msg);
  }

  // uid()：產生規則的唯一 id（時間戳轉 36 進位 + 隨機字串）。
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // hostOf(url)：取網址的主機名稱（如 www.google.com），網址無效回傳空字串。
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "";
    }
  }

  // isHttpUrl(url)：判斷是否為 http / https 網址（擋掉 javascript: 之類危險協定）。
  function isHttpUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  // fillKeyword(template, keyword)：把網址模板的 @keyword 換成編碼後的關鍵字。
  function fillKeyword(template, keyword) {
    return String(template || "").replace(/@keyword/g, encodeURIComponent(keyword || ""));
  }

  // currentUser()：取得目前登入的使用者名稱（小寫）；訪客或沒登入回傳 null。
  // 依序看 sessionStorage（本次登入）和 localStorage（記住我）。
  // 與 app.js 的 getCurrentUser 相同的判斷：訪客只存本機
  function currentUser() {
    let user = null;
    try {
      const sessionStored = sessionStorage.getItem("currentUser");
      const remStored = localStorage.getItem("rememberedUser");
      if (sessionStored) user = JSON.parse(sessionStored)?.username;
      else if (remStored) user = JSON.parse(remStored)?.user?.username;
    } catch (e) {}
    user = (user || (window.state && window.state.currentUser) || "").toLowerCase().trim();
    return !user || user === "訪客" || user === "guest" ? null : user;
  }

  // 儲存與同步：資料來源有兩份——本機 localStorage 與伺服器，以 updatedAt 較新的為準。
  // ==================== 儲存與同步 ====================
  // store：記憶體中的所有規則 { rules: [...], updatedAt }。
  let store = { rules: [], updatedAt: null };

  // loadLocal()：從 localStorage 讀入 store；資料壞掉就略過（不讓頁面報錯）。
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.rules)) store = { rules: parsed.rules, updatedAt: parsed.updatedAt || null };
      }
    } catch (e) {
      console.warn("[CustomRules] 讀取本機規則失敗", e);
    }
  }

  // writeLocal()：寫回 localStorage；空間不足時提示使用者。
  function writeLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      toast("瀏覽器儲存空間不足，規則未能保存", "bi-exclamation-triangle text-warning");
    }
  }

  // save()：任何規則變更後都呼叫它。先存本機，若已登入再「防抖」400ms 後推到伺服器
  // （防抖 debounce：連續多次修改只送最後一次，避免狂送請求）。
  let pushTimer = null;
  function save() {
    store.updatedAt = new Date().toISOString();
    writeLocal();
    const user = currentUser();
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushToServer(user), 400);
  }

  // pushToServer(user)：POST /api/user/custom-rules，把整份規則上傳到帳號。失敗只警告，視為離線模式（本機仍可用）。
  async function pushToServer(user) {
    try {
      await fetch("/api/user/custom-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, rules: store.rules, updatedAt: store.updatedAt }),
      });
    } catch (e) {
      console.warn("[CustomRules] 同步到伺服器失敗 (離線模式)", e.message);
    }
  }

  // syncFromServer()：頁面載入時呼叫。比較伺服器與本機的 updatedAt：
  // 伺服器較新 -> 覆蓋本機並重畫畫面；本機較新且有規則 -> 推上去伺服器。
  // 以較新的一方為準 (整份規則一起比較 updatedAt)
  async function syncFromServer() {
    const user = currentUser();
    if (!user) return;
    try {
      const res = await fetch(`/api/user/custom-rules?user=${encodeURIComponent(user)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.success) return;
      const remoteAt = data.updatedAt ? Date.parse(data.updatedAt) : 0;
      const localAt = store.updatedAt ? Date.parse(store.updatedAt) : 0;
      if (remoteAt > localAt && Array.isArray(data.rules)) {
        store = { rules: data.rules, updatedAt: data.updatedAt };
        writeLocal();
        refreshAll();
      } else if (localAt > remoteAt && store.rules.length) {
        pushToServer(user);
      }
    } catch (e) {
      console.warn("[CustomRules] 讀取伺服器規則失敗", e.message);
    }
  }

  // rulesOf(kind, mode, onlyEnabled)：篩選規則。kind 動畫 / 漫畫；mode 可選 xpath / jump；onlyEnabled 只取啟用中的。
  function rulesOf(kind, mode, onlyEnabled) {
    return store.rules.filter(
      (r) => r.kind === kind && (!mode || r.mode === mode) && (!onlyEnabled || r.enabled !== false),
    );
  }

  // findRule(id)：依 id 找規則。
  function findRule(id) {
    return store.rules.find((r) => r.id === id);
  }

  // 規則驗證 / 匯入匯出。
  // ==================== 規則驗證 / 匯入匯出 ====================
  // validateRule(rule)：檢查規則填得對不對。回傳錯誤訊息字串，沒問題回傳空字串 ""。
  // 檢查：必填欄位、搜尋網址是 http/https 且含 @keyword、首頁網址格式、圖示格式（bi-xxx 或 1~2 個 emoji）。
  function validateRule(rule) {
    const def = FIELDS[rule.mode === "jump" ? "jump" : `${rule.kind}:xpath`];
    for (const [key, label, required] of def) {
      if (required && !BOOL_FIELDS.has(key) && !String(rule[key] || "").trim()) return `請填寫「${label}」`;
    }
    if (!isHttpUrl(fillKeyword(rule.searchURL, "test"))) return "搜尋網址必須是 http:// 或 https:// 開頭";
    if (!/@keyword/.test(rule.searchURL)) return "搜尋網址必須包含 @keyword (代表搜尋關鍵字)";
    if (rule.baseURL && !isHttpUrl(rule.baseURL)) return "網站首頁必須是 http:// 或 https:// 開頭";
    if (rule.mode === "jump" && rule.icon && !/^bi-[a-z0-9-]+$/.test(rule.icon) && [...rule.icon].length > 2)
      return "圖示請填 Bootstrap Icons 名稱 (bi-xxx) 或 1~2 個 emoji";
    return "";
  }

  // fromImported(obj, kind)：把匯入的 JSON 物件轉成內部規則。有 searchList 當 xpath 規則，只有 searchURL 當 jump。
  // 過濾系統欄位、字串截到 4000 字、只收字串 / 布林 / 數字，最後呼叫 validateRule；有問題丟 Error。
  // 匯入的 JSON：有 searchList 視為 XPath 規則，只有 searchURL 視為搜尋跳轉
  function fromImported(obj, kind) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("每條規則必須是 JSON 物件");
    if (obj.type && obj.type !== kind) throw new Error(`「${obj.name || "未命名"}」的 type 是 ${obj.type}，不是${kindLabel(kind)}規則`);
    const mode = obj.mode === "jump" || (!obj.searchList && obj.searchURL) ? "jump" : "xpath";
    const rule = {};
    for (const [k, v] of Object.entries(obj)) {
      if (META_KEYS.includes(k)) continue;
      if (typeof v === "string") rule[k] = v.slice(0, 4000);
      else if (typeof v === "boolean" || typeof v === "number") rule[k] = v;
    }
    Object.assign(rule, { kind, mode, enabled: true });
    const err = validateRule(rule);
    if (err) throw new Error(`「${obj.name || "未命名"}」${err}`);
    return rule;
  }

  // exportRule(rule)：匯出成乾淨的 JSON（拿掉系統欄位與空值），格式盡量與 Kazumi 規則相同，可分享給別人。
  function exportRule(rule) {
    const out = {};
    if (rule.mode === "jump") Object.assign(out, { type: rule.kind, mode: "jump" });
    else if (rule.kind === "anime") Object.assign(out, { api: rule.api || "1", type: "anime" });
    else out.type = rule.kind;
    for (const [k, v] of Object.entries(rule)) {
      if (!META_KEYS.includes(k) && !(k in out) && v !== "" && v !== false) out[k] = v;
    }
    return out;
  }

  // upsertRules(list)：批次新增或更新。同種類、同模式、同名稱視為同一條 -> 覆蓋更新（保留原 id、建立時間、啟用狀態）；否則新增。
  // 回傳 [新增數, 更新數]，最後 save()。
  // 同名規則直接覆蓋更新，其餘新增；回傳 [新增數, 更新數]
  function upsertRules(list) {
    let added = 0;
    let updated = 0;
    for (const rule of list) {
      const existing = store.rules.find((r) => r.kind === rule.kind && r.mode === rule.mode && r.name === rule.name);
      if (existing) {
        const keep = { id: existing.id, createdAt: existing.createdAt, enabled: existing.enabled };
        for (const k of Object.keys(existing)) delete existing[k];
        Object.assign(existing, rule, keep, { updatedAt: new Date().toISOString() });
        updated++;
      } else {
        store.rules.push({ ...rule, id: uid(), createdAt: new Date().toISOString() });
        added++;
      }
    }
    save();
    return [added, updated];
  }

  // 呼叫後端 API。
  // ==================== 後端 API ====================
  // post(path, body)：POST JSON 到後端並解析回應。HTTP 錯誤或 success:false 時丟 Error（訊息取後端的 error）。
  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    if (!res.ok || !data || data.success === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // 自訂來源 id = "custom-" + 規則 id，用前綴區分內建來源與自訂來源（且只含英數與連字號，才能安全當 DOM id）。
  // app.js 會拿來源 id 組 DOM id 和 querySelector，只能用英數與連字號
  const SOURCE_PREFIX = "custom-";

  // ruleFromSourceId(sourceId)：由來源 id 找回規則，找不到（可能已刪除）丟 Error。
  function ruleFromSourceId(sourceId) {
    const rule = findRule(String(sourceId || "").slice(SOURCE_PREFIX.length));
    if (!rule) throw new Error("找不到這條自訂規則，可能已被刪除");
    return rule;
  }

  // 漫畫沒有固定 id，所以自己編碼：crule:規則id|詳情網址。mangaIdFor 產生；parseMangaId 反向解析出規則與網址。
  // 單引號轉成 %27，避免破壞 app.js 用字串拼出來的 onclick。
  // 漫畫結果 id：crule:<規則 id>|<詳情網址>  (' 轉成 %27 避免破壞 app.js 的 onclick 字串)
  function mangaIdFor(rule, detailUrl) {
    return `crule:${rule.id}|${encodeURIComponent(detailUrl).replace(/'/g, "%27")}`;
  }
  function parseMangaId(mangaId) {
    const m = /^crule:([^|]+)\|(.*)$/.exec(String(mangaId || ""));
    if (!m) throw new Error("無效的自訂漫畫 ID");
    const rule = findRule(m[1]);
    if (!rule) throw new Error("找不到這條自訂漫畫規則，可能已被刪除");
    return { rule, detailUrl: decodeURIComponent(m[2]) };
  }

  // 對外公開的 API（會掛到 window.CustomRules）：
  //  animeSources / isCustomSource：提供動畫來源清單、判斷是否為自訂來源
  //  animeSearch / animeEpisodes / animePlay：搜尋 -> 取集數 -> 取播放連結（對應 /api/kazumi/custom-*）
  //  mangaSearchAll：同時用所有漫畫規則搜尋（Promise.allSettled：一條失敗不影響其他）
  //  mangaChapters / mangaPages：取章節、取圖片（對應 /api/manga/custom-*）
  //  onAnimeSearch / onMangaSearch：記下最近的搜尋關鍵字並更新跳轉按鈕
  //  openManager：打開規則管理視窗；list：取得規則複本
  const api = {
    animeSources() {
      return rulesOf("anime", "xpath", true).map((r) => ({
        id: SOURCE_PREFIX + r.id,
        name: r.name,
        desc: `自訂規則 · ${hostOf(r.baseURL || fillKeyword(r.searchURL, "")) || "Kazumi XPath"}`,
        custom: true,
      }));
    },
    isCustomSource(sourceId) {
      return String(sourceId || "").startsWith(SOURCE_PREFIX);
    },
    async animeSearch(sourceId, q) {
      return post("/api/kazumi/custom-search", { rule: ruleFromSourceId(sourceId), q });
    },
    async animeEpisodes(sourceId, detailUrl) {
      const data = await post("/api/kazumi/custom-episodes", { rule: ruleFromSourceId(sourceId), detailUrl });
      // 劇院換集時沒有 sourceId，靠這個欄位找回規則
      (data.episodes || []).forEach((ep) => (ep.customSourceId = sourceId));
      return data;
    },
    async animePlay(sourceId, playUrl) {
      return post("/api/kazumi/custom-play", { rule: ruleFromSourceId(sourceId), playUrl });
    },
    async mangaSearchAll(q) {
      const rules = rulesOf("manga", "xpath", true);
      const settled = await Promise.allSettled(rules.map((r) => post("/api/manga/custom-search", { rule: r, q })));
      const out = [];
      settled.forEach((s, i) => {
        const rule = rules[i];
        if (s.status !== "fulfilled") {
          console.warn(`[CustomRules] 漫畫規則「${rule.name}」搜尋失敗：`, s.reason && s.reason.message);
          return;
        }
        (s.value.results || []).forEach((m) =>
          out.push({
            id: mangaIdFor(rule, m.detailUrl),
            title: m.title,
            cover: m.cover,
            author: "",
            brief: `自訂規則 · ${hostOf(m.detailUrl)}`,
            source: rule.name,
          }),
        );
      });
      return out;
    },
    async mangaChapters(mangaId) {
      const { rule, detailUrl } = parseMangaId(mangaId);
      return post("/api/manga/custom-chapters", { rule, detailUrl });
    },
    async mangaPages(mangaId, chapterUrl) {
      const { rule } = parseMangaId(mangaId);
      return post("/api/manga/custom-pages", { rule, chapterUrl });
    },
    // 小說：啟用中的 XPath 規則會變成小說書源按鈕；app.js 用 novelRule 取規則再 POST 到 /api/novel/custom-*
    novelSources() {
      return rulesOf("novel", "xpath", true).map((r) => ({ id: SOURCE_PREFIX + r.id, name: r.name }));
    },
    novelRule(sourceId) {
      return ruleFromSourceId(sourceId);
    },
    onNovelSearch(keyword) {
      lastKeyword.novel = keyword || "";
      renderJumpRow("novel");
    },
    onAnimeSearch(keyword) {
      lastKeyword.anime = keyword || "";
      renderJumpRow("anime");
    },
    onMangaSearch(keyword) {
      lastKeyword.manga = keyword || "";
      renderJumpRow("manga");
    },
    openManager,
    list: () => store.rules.slice(),
  };

  // 搜尋跳轉按鈕列：在來源彈窗中插入一排按鈕，點了到外部網站搜尋。
  // lastKeyword 記住最近的關鍵字；JUMP_ANCHOR 說明按鈕列要插在哪個既有元素之前、輸入框 id 是什麼。
  // ==================== 搜尋跳轉按鈕列 ====================
  const lastKeyword = { anime: "", manga: "", novel: "" };
  const JUMP_ANCHOR = {
    anime: { modal: "kazumiSourceModal", before: "kazumiSourceList", input: "kazumiModalKeywordInput" },
    manga: { modal: "mangaSourceModal", before: "mangaSelectedSummaryBox", input: "mangaDrawerKeywordInput" },
    novel: { modal: "novelSourceModal", before: "novelSelectedSummaryBox", input: "novelDrawerKeywordInput" },
  };

  // iconHtml(icon)：產生按鈕圖示的 HTML：沒設定用預設圖示；bi-xxx 用 Bootstrap Icons；否則當 emoji 文字（有跳脫）。
  function iconHtml(icon) {
    if (!icon) return '<i class="bi bi-box-arrow-up-right"></i>';
    if (/^bi-[a-z0-9-]+$/.test(icon)) return `<i class="bi ${icon}"></i>`;
    return `<span aria-hidden="true">${esc(icon)}</span>`;
  }

  // renderJumpRow(kind)：畫出（或更新）搜尋跳轉按鈕列。
  // 有關鍵字就連到「該網站的搜尋結果」；沒有關鍵字就連到網站首頁（origin）。連結用 noopener noreferrer 避免新分頁操控原頁面。
  function renderJumpRow(kind) {
    const anchor = JUMP_ANCHOR[kind];
    const before = document.getElementById(anchor.before);
    if (!before || !before.parentNode) return;
    let row = document.getElementById(`customJumpRow-${kind}`);
    if (!row) {
      row = document.createElement("div");
      row.id = `customJumpRow-${kind}`;
      row.className = "custom-jump-row";
      before.parentNode.insertBefore(row, before);
    }
    const input = document.getElementById(anchor.input);
    const keyword = (lastKeyword[kind] || (input && input.value) || "").trim();
    const jumps = rulesOf(kind, "jump", true);
    const links = jumps
      .map((r) => {
        const href = keyword ? fillKeyword(r.searchURL, keyword) : (() => {
          try {
            return new URL(fillKeyword(r.searchURL, "")).origin + "/";
          } catch (e) {
            return "#";
          }
        })();
        if (!isHttpUrl(href)) return "";
        return `<a class="btn btn-xs btn-outline-info custom-jump-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(keyword ? `在 ${r.name} 搜尋「${keyword}」` : `開啟 ${r.name}`)}">${iconHtml(r.icon)} ${esc(r.name)}</a>`;
      })
      .join("");
    row.innerHTML = `
      <span class="custom-jump-label"><i class="bi bi-signpost-split"></i> ${jumps.length ? "跳轉搜尋" : "自訂來源"}</span>
      ${links || `<span class="custom-jump-hint">新增「搜尋跳轉」規則，就能一鍵到其他網站搜尋${kind === "anime" ? "；匯入 Kazumi 規則可直接在站內播放" : kind === "novel" ? "；XPath 規則會變成上方的書源按鈕" : "；XPath 規則的結果會直接出現在下方"}</span>`}
      <button type="button" class="btn btn-xs btn-outline-light custom-jump-manage" data-custom-rules-open="${kind}"><i class="bi bi-sliders"></i> 自訂規則</button>
    `;
  }

  // refreshAll()：規則變動後重畫所有相關畫面（兩個跳轉列 + 若管理視窗開著也重畫）。
  function refreshAll() {
    renderJumpRow("anime");
    renderJumpRow("manga");
    renderJumpRow("novel");
    if (typeof window.updateNovelSourcePills === "function") window.updateNovelSourcePills();
    if (managerKind) renderManager();
  }

  // 規則管理 Modal（彈出視窗）。用三個狀態變數控制畫面：managerKind（動畫 / 漫畫）、managerView（list 清單 / edit 編輯 / import 匯入）、editing（編輯中的規則複本）。
  // 畫面做法：狀態改變 -> renderManager() 重新產生 HTML 塞進視窗；按鈕用 data-act 屬性標記動作，統一由 onManagerClick 處理（事件委派）。
  // ==================== 規則管理 Modal ====================
  let managerKind = null; // 'anime' | 'manga' | 'novel'
  let managerView = "list"; // 'list' | 'edit' | 'import'
  let editing = null; // 編輯中的規則 (複本)

  // ensureModal()：第一次用到時才建立 Modal 的 HTML 並加進頁面（之後重複使用）。同時綁好事件：
  //  shown：把背景遮罩加上自訂 class，讓它疊在原本的來源視窗之上；
  //  hidden：清掉狀態，並在底下仍有別的 Modal 時維持 body 的 modal-open（避免背景可捲動）。
  function ensureModal() {
    let el = document.getElementById("customRulesModal");
    if (el) return el;
    el = document.createElement("div");
    el.className = "modal fade custom-rules-modal";
    el.id = "customRulesModal";
    el.tabIndex = -1;
    el.setAttribute("aria-labelledby", "customRulesModalLabel");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg">
        <div class="modal-content bg-dark text-white border-secondary rounded-4 shadow-lg overflow-hidden">
          <div class="modal-header border-bottom border-secondary py-3 px-4 bg-black">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="badge bg-info text-dark"><i class="bi bi-sliders"></i> 自訂規則</span>
              <h5 class="modal-title fw-bold mb-0" id="customRulesModalLabel">來源規則管理</h5>
            </div>
            <button type="button" class="btn-close btn-close-white ms-auto" data-bs-dismiss="modal" aria-label="關閉"></button>
          </div>
          <div class="modal-body p-3 p-md-4 bg-dark" id="customRulesBody"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    // 疊在播放來源 / 漫畫來源 Modal 之上
    el.addEventListener("shown.bs.modal", () => {
      const backdrops = document.querySelectorAll(".modal-backdrop");
      const last = backdrops[backdrops.length - 1];
      if (last) last.classList.add("custom-rules-backdrop");
    });
    el.addEventListener("hidden.bs.modal", () => {
      managerKind = null;
      // 關掉後若底下還有 Modal 開著，維持 body 的 modal-open 避免背景捲動
      if (document.querySelector(".modal.show")) document.body.classList.add("modal-open");
    });
    el.addEventListener("click", onManagerClick);
    el.addEventListener("change", onManagerChange);
    return el;
  }

  // openManager(kind)：打開規則管理視窗。kind 為 'anime' 或 'manga'。
  function openManager(kind) {
    managerKind = kind === "manga" || kind === "novel" ? kind : "anime";
    managerView = "list";
    editing = null;
    const el = ensureModal();
    renderManager();
    bootstrap.Modal.getOrCreateInstance(el).show();
  }

  // kindLabel(kind)：種類的中文名稱。
  function kindLabel(kind) {
    return kind === "anime" ? "動畫" : kind === "novel" ? "小說" : "漫畫";
  }

  // renderManager()：依 managerView 決定內容（編輯 / 匯入 / 清單），並畫出上方動畫 / 漫畫分頁標籤與各自的規則數量。
  function renderManager() {
    const body = document.getElementById("customRulesBody");
    if (!body || !managerKind) return;
    const tabs = ["anime", "manga", "novel"]
      .map(
        (k) => `<li class="nav-item"><button type="button" class="nav-link rounded-pill ${k === managerKind ? "active" : ""}" data-act="tab" data-kind="${k}">
          <i class="bi ${k === "anime" ? "bi-play-circle" : k === "novel" ? "bi-journal-text" : "bi-book"}"></i> ${kindLabel(k)}規則 <span class="badge bg-secondary ms-1">${rulesOf(k).length}</span></button></li>`,
      )
      .join("");
    let content = "";
    if (managerView === "edit") content = editorHtml();
    else if (managerView === "import") content = importHtml();
    else content = listHtml();
    body.innerHTML = `<ul class="nav nav-pills gap-2 mb-3">${tabs}</ul>${content}`;
  }

  // listHtml()：產生規則清單的 HTML（每列有啟用開關、編輯、匯出、刪除）。所有使用者內容都經過 esc() 跳脫。
  function listHtml() {
    const kind = managerKind;
    const rules = rulesOf(kind);
    const rows = rules
      .map((r) => {
        const isJump = r.mode === "jump";
        const host = hostOf(r.baseURL || fillKeyword(r.searchURL, ""));
        return `
        <div class="custom-rule-row ${r.enabled === false ? "is-disabled" : ""}">
          <div class="form-check form-switch m-0" title="啟用 / 停用">
            <input class="form-check-input" type="checkbox" role="switch" data-act="toggle" data-id="${esc(r.id)}" ${r.enabled === false ? "" : "checked"} aria-label="啟用 ${esc(r.name)}">
          </div>
          <div class="flex-grow-1 overflow-hidden">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="fw-semibold text-truncate">${isJump ? iconHtml(r.icon) + " " : ""}${esc(r.name)}</span>
              <span class="badge ${isJump ? "bg-secondary" : "bg-danger-subtle text-danger"}">${isJump ? "搜尋跳轉" : kind === "anime" ? "Kazumi XPath" : "XPath 規則"}</span>
            </div>
            <div class="small text-white-50 text-truncate">${esc(host)}${r.version ? ` · v${esc(r.version)}` : ""}</div>
          </div>
          <div class="d-flex gap-1 flex-shrink-0">
            <button type="button" class="btn btn-xs btn-outline-light" data-act="edit" data-id="${esc(r.id)}" title="編輯"><i class="bi bi-pencil"></i><span class="d-none d-sm-inline"> 編輯</span></button>
            <button type="button" class="btn btn-xs btn-outline-info" data-act="export" data-id="${esc(r.id)}" title="複製規則 JSON"><i class="bi bi-clipboard"></i><span class="d-none d-sm-inline"> 匯出</span></button>
            <button type="button" class="btn btn-xs btn-outline-danger" data-act="delete" data-id="${esc(r.id)}" title="刪除"><i class="bi bi-trash3"></i></button>
          </div>
        </div>`;
      })
      .join("");
    const intro =
      kind === "anime"
        ? `<b>Kazumi XPath 規則</b>會和內建來源一起出現在「播放來源」清單，可站內搜尋、選集與播放；<b>搜尋跳轉</b>只要填名稱與搜尋網址，點了直接在新分頁開該站搜尋結果。`
        : kind === "novel"
          ? `<b>XPath 規則</b>會變成小說搜尋視窗裡的書源按鈕，可站內搜尋、看目錄、讀正文（格式借鑑 Legado 書源：搜尋 → 目錄 → 正文）；<b>搜尋跳轉</b>會在搜尋時多一排按鈕，一鍵到其他網站。`
          : `<b>XPath 規則</b>的結果會直接出現在漫畫搜尋結果，可選集並用條漫閱讀器看；<b>搜尋跳轉</b>會在搜尋時多一排按鈕，一鍵到其他網站。`;
    return `
      <p class="small text-white-50 mb-3">${intro}</p>
      <div class="d-flex flex-wrap gap-2 mb-3">
        <button type="button" class="btn btn-sm btn-info text-dark" data-act="import-view"><i class="bi bi-clipboard-plus"></i> 貼上${kind === "anime" ? " Kazumi" : ""} JSON 匯入</button>
        <button type="button" class="btn btn-sm btn-outline-light" data-act="new" data-mode="xpath"><i class="bi bi-code-slash"></i> 新增 XPath 規則</button>
        <button type="button" class="btn btn-sm btn-outline-light" data-act="new" data-mode="jump"><i class="bi bi-box-arrow-up-right"></i> 新增搜尋跳轉</button>
      </div>
      <div class="d-flex flex-column gap-2">
        ${rows || `<div class="text-center text-white-50 py-4 border border-secondary border-opacity-50 rounded-3"><i class="bi bi-inbox fs-3 d-block mb-1"></i>還沒有${kindLabel(kind)}自訂規則</div>`}
      </div>
      <p class="small text-white-50 mt-3 mb-0"><i class="bi bi-cloud-check"></i> ${currentUser() ? `規則存在這台瀏覽器，並同步到帳號「${esc(currentUser())}」` : "訪客模式：規則只存在這台瀏覽器 (登入後可跨裝置同步)"}</p>`;
  }

  // importHtml()：產生「貼上 JSON 匯入」畫面的 HTML。
  function importHtml() {
    const kind = managerKind;
    const sample = JSON.stringify(sampleOf(kind), null, 2);
    return `
      <div class="mb-2 d-flex align-items-center justify-content-between flex-wrap gap-2">
        <div class="fw-semibold"><i class="bi bi-clipboard-plus"></i> 貼上${kind === "anime" ? " Kazumi " : ""}規則 JSON</div>
        <button type="button" class="btn btn-xs btn-outline-secondary text-white" data-act="fill-sample-import"><i class="bi bi-magic"></i> 填入範例</button>
      </div>
      <p class="small text-white-50 mb-2">${
        kind === "anime"
          ? "可直接貼上 KazumiRules 規則庫裡的 .json 內容 (單一物件或陣列)。同名規則會被更新。"
          : kind === "novel"
            ? "格式仿 Legado 書源：searchURL / searchList / searchName / searchResult / chapterResult / contentNode，另可選 searchAuthor、searchCover、chapterList、contentTitle。只有 name + searchURL 會當成搜尋跳轉。"
            : "格式仿 Kazumi：searchURL / searchList / searchName / searchResult / chapterResult，另可選 searchCover、chapterList、pageImage。只有 name + searchURL 會當成搜尋跳轉。"
      }</p>
      <textarea class="form-control bg-black text-white border-secondary font-monospace small" id="customRulesImportText" rows="12" spellcheck="false" placeholder='${esc(sample)}'></textarea>
      <div id="customRulesImportMsg" class="small mt-2"></div>
      <div class="d-flex gap-2 mt-3">
        <button type="button" class="btn btn-sm btn-info text-dark" data-act="import-do"><i class="bi bi-download"></i> 匯入</button>
        <button type="button" class="btn btn-sm btn-outline-light" data-act="back"><i class="bi bi-arrow-left"></i> 返回</button>
      </div>`;
  }

  // editorHtml()：產生編輯表單的 HTML。表單欄位依 FIELDS 表動態產生；進階欄位收在 <details> 裡；xpath 規則多一個「測試規則」區塊。
  function editorHtml() {
    const r = editing;
    const def = FIELDS[r.mode === "jump" ? "jump" : `${r.kind}:xpath`];
    const field = ([key, label, required, hint]) => {
      const id = `crf-${key}`;
      if (BOOL_FIELDS.has(key)) {
        return `<div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" id="${id}" data-field="${key}" ${r[key] === true || r[key] === "true" ? "checked" : ""}>
          <label class="form-check-label small" for="${id}">${esc(label)}</label>
          ${hint ? `<div class="form-text text-white-50">${esc(hint)}</div>` : ""}
        </div>`;
      }
      const mono = !["name", "icon"].includes(key);
      return `<div class="mb-2">
        <label class="form-label small mb-1" for="${id}">${esc(label)}${required ? ' <span class="text-danger">*</span>' : ""}</label>
        <input type="text" class="form-control form-control-sm bg-black text-white border-secondary ${mono ? "font-monospace" : ""}" id="${id}" data-field="${key}" value="${esc(r[key] || "")}" ${required ? "required" : ""} spellcheck="false" autocomplete="off">
        ${hint ? `<div class="form-text text-white-50">${esc(hint)}</div>` : ""}
      </div>`;
    };
    const basic = def.filter((d) => !d[4]).map(field).join("");
    const advanced = def.filter((d) => d[4]).map(field).join("");
    const isNew = !r.id;
    const modeName = r.mode === "jump" ? "搜尋跳轉" : r.kind === "anime" ? "Kazumi XPath 規則" : "XPath 規則";
    return `
      <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <div class="fw-semibold">${isNew ? "新增" : "編輯"}${kindLabel(r.kind)}${modeName}</div>
        ${r.mode === "xpath" ? `<button type="button" class="btn btn-xs btn-outline-secondary text-white" data-act="fill-sample"><i class="bi bi-magic"></i> 填入範例</button>` : ""}
      </div>
      <form id="customRuleForm" novalidate>
        ${basic}
        ${advanced ? `<details class="mb-2"><summary class="small text-white-50">進階選項</summary><div class="pt-2">${advanced}</div></details>` : ""}
      </form>
      ${
        r.mode === "xpath"
          ? `<div class="custom-rule-test mt-3">
          <div class="small fw-semibold mb-1"><i class="bi bi-bug"></i> 測試規則 (不必先儲存)</div>
          <div class="input-group input-group-sm">
            <input type="text" class="form-control bg-black text-white border-secondary" id="customRuleTestKw" placeholder="輸入測試關鍵字，例如 ${r.kind === "anime" ? "葬送的芙莉莲" : r.kind === "novel" ? "西遊記" : "葬送的芙莉蓮"}">
            <button type="button" class="btn btn-outline-info" data-act="test-search"><i class="bi bi-search"></i> 測試搜尋</button>
          </div>
          <div id="customRuleTestOut" class="small mt-2"></div>
        </div>`
          : ""
      }
      <div id="customRuleFormMsg" class="small text-danger mt-2"></div>
      <div class="d-flex gap-2 mt-3">
        <button type="button" class="btn btn-sm btn-info text-dark" data-act="save"><i class="bi bi-check-lg"></i> 儲存</button>
        <button type="button" class="btn btn-sm btn-outline-light" data-act="back"><i class="bi bi-arrow-left"></i> 返回</button>
      </div>`;
  }

  // readForm()：把表單目前的值讀成規則物件（從 editing 複製一份，保留匯入時多出來的 Kazumi 欄位）。fillForm(values)：反向，把值填進表單。
  // 從表單讀出規則 (保留原本匯入時的其他 Kazumi 欄位)
  function readForm() {
    const rule = { ...editing };
    document.querySelectorAll("#customRuleForm [data-field]").forEach((input) => {
      const key = input.dataset.field;
      if (BOOL_FIELDS.has(key)) rule[key] = input.checked;
      else rule[key] = input.value.trim();
    });
    return rule;
  }

  function fillForm(values) {
    document.querySelectorAll("#customRuleForm [data-field]").forEach((input) => {
      const key = input.dataset.field;
      if (!(key in values)) return;
      if (BOOL_FIELDS.has(key)) input.checked = values[key] === true;
      else input.value = values[key];
    });
  }

  // runTest()：「測試搜尋」按鈕。不用先儲存，直接用表單內容呼叫後端搜尋，顯示找到幾筆結果（或錯誤原因）。
  // 若 searchList 選到節點但沒解析出標題 + 連結，會提示使用者檢查 XPath。關鍵字沒填就用輸入框 placeholder 的範例。
  async function runTest() {
    const out = document.getElementById("customRuleTestOut");
    const kwInput = document.getElementById("customRuleTestKw");
    const rule = readForm();
    const err = validateRule(rule);
    if (err) {
      out.innerHTML = `<span class="text-danger">${esc(err)}</span>`;
      return;
    }
    const q = (kwInput.value || kwInput.placeholder.replace(/^.*例如\s*/, "")).trim();
    out.innerHTML = `<span class="text-white-50"><span class="spinner-border spinner-border-sm"></span> 正在抓取 ${esc(fillKeyword(rule.searchURL, q))} ...</span>`;
    try {
      const searchPath = { anime: "/api/kazumi/custom-search", manga: "/api/manga/custom-search", novel: "/api/novel/custom-search" }[rule.kind];
      const data = await post(searchPath, { rule, q });
      // 小說結果用 id 當詳情網址，統一成 detailUrl 方便下面顯示與測試
      const list = (data.results || []).map((m) => ({ ...m, detailUrl: m.detailUrl || m.id }));
      if (!list.length) {
        out.innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> searchList 選到 ${data.matched || 0} 個節點，但沒有解析出標題 + 連結。請檢查 XPath。</span>`;
        return;
      }
      out.innerHTML = `<div class="text-success mb-1"><i class="bi bi-check-circle"></i> 找到 ${list.length} 筆結果 (searchList 選到 ${data.matched} 個節點)</div>
        <ol class="mb-1 ps-3">${list.slice(0, 6).map((m, i) => `<li><span class="text-white">${esc(m.title)}</span> <span class="text-white-50">${esc(m.detailUrl)}</span>
        ${i === 0 ? ` <button type="button" class="btn btn-xs btn-outline-info ms-1" data-act="test-detail" data-url="${esc(m.detailUrl)}">${rule.kind === "anime" ? "測試選集" : rule.kind === "novel" ? "測試目錄與正文" : "測試章節"}</button>` : ""}</li>`).join("")}</ol>
        <div id="customRuleTestDetail"></div>`;
    } catch (e) {
      out.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${esc(e.message)}</span>`;
    }
  }

  // runDetailTest(detailUrl)：測試第一筆結果的後續步驟。動畫：取集數；漫畫：取章節，再取第一章圖片並顯示縮圖。
  async function runDetailTest(detailUrl) {
    const box = document.getElementById("customRuleTestDetail");
    if (!box) return;
    const rule = readForm();
    box.innerHTML = `<span class="text-white-50"><span class="spinner-border spinner-border-sm"></span> 解析中...</span>`;
    try {
      if (rule.kind === "anime") {
        const data = await post("/api/kazumi/custom-episodes", { rule, detailUrl });
        const eps = data.episodes || [];
        box.innerHTML = eps.length
          ? `<span class="text-success"><i class="bi bi-check-circle"></i> 解析出 ${eps.length} 集：</span> ${eps.slice(0, 8).map((e) => esc(e.title)).join("、")}${eps.length > 8 ? " …" : ""}`
          : `<span class="text-warning">沒有解析出集數，請檢查 chapterRoads / chapterResult</span>`;
      } else if (rule.kind === "novel") {
        const data = await post("/api/novel/custom-chapters", { rule, novelId: detailUrl });
        const chs = data.chapters || [];
        if (!chs.length) {
          box.innerHTML = `<span class="text-warning">沒有解析出章節，請檢查 chapterList / chapterResult</span>`;
          return;
        }
        const content = await post("/api/novel/custom-content", { rule, chapterId: chs[0].id });
        const paras = content.paragraphs || [];
        box.innerHTML = `<div class="text-success"><i class="bi bi-check-circle"></i> ${chs.length} 個章節；「${esc(content.title || chs[0].title)}」有 ${paras.length} 段正文</div>
          <div class="text-white-50 mt-1 text-truncate">${esc(paras[0] || "")}</div>`;
      } else {
        const data = await post("/api/manga/custom-chapters", { rule, detailUrl });
        const chs = data.chapters || [];
        if (!chs.length) {
          box.innerHTML = `<span class="text-warning">沒有解析出章節，請檢查 chapterList / chapterResult</span>`;
          return;
        }
        const pages = await post("/api/manga/custom-pages", { rule, chapterUrl: chs[0].id });
        const imgs = pages.pages || [];
        box.innerHTML = `<div class="text-success"><i class="bi bi-check-circle"></i> ${chs.length} 個章節；「${esc(chs[0].title)}」有 ${imgs.length} 張圖</div>
          <div class="d-flex gap-1 mt-1">${imgs.slice(0, 4).map((src) => `<img src="${esc(src)}" alt="" class="custom-rule-thumb" loading="lazy">`).join("")}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${esc(e.message)}</span>`;
    }
  }

  // doImport()：處理「匯入」按鈕。解析貼上的 JSON（單一物件或陣列都可）-> 逐條 fromImported 驗證 -> 成功的用 upsertRules 寫入，格式有誤的略過並提示。
  function doImport() {
    const text = (document.getElementById("customRulesImportText").value || "").trim();
    const msg = document.getElementById("customRulesImportMsg");
    if (!text) {
      msg.innerHTML = `<span class="text-danger">請先貼上規則 JSON</span>`;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      msg.innerHTML = `<span class="text-danger">JSON 格式錯誤：${esc(e.message)}</span>`;
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rules = [];
    const errors = [];
    list.forEach((obj) => {
      try {
        rules.push(fromImported(obj, managerKind));
      } catch (e) {
        errors.push(e.message);
      }
    });
    if (!rules.length) {
      msg.innerHTML = `<span class="text-danger">${errors.map(esc).join("<br>")}</span>`;
      return;
    }
    const [added, updated] = upsertRules(rules);
    toast(`已匯入 ${added} 條、更新 ${updated} 條${kindLabel(managerKind)}規則${errors.length ? `，${errors.length} 條格式有誤` : ""}`, "bi-check-circle-fill text-success");
    managerView = "list";
    refreshAll();
    if (errors.length) console.warn("[CustomRules] 匯入略過：", errors);
  }

  // saveEditing()：儲存編輯中的規則。驗證通過後：有 id 就更新原規則，沒有就新增（產生 id、預設啟用）。
  function saveEditing() {
    const msg = document.getElementById("customRuleFormMsg");
    const rule = readForm();
    const err = validateRule(rule);
    if (err) {
      msg.textContent = err;
      return;
    }
    if (rule.id) {
      const idx = store.rules.findIndex((x) => x.id === rule.id);
      if (idx >= 0) store.rules[idx] = { ...rule, updatedAt: new Date().toISOString() };
    } else {
      store.rules.push({ ...rule, id: uid(), enabled: true, createdAt: new Date().toISOString() });
    }
    save();
    toast(`已儲存規則「${rule.name}」`, "bi-check-circle-fill text-success");
    managerView = "list";
    editing = null;
    refreshAll();
  }

  // copyText(text)：複製文字到剪貼簿。優先用新的 navigator.clipboard；不行（如非 https 環境）就用隱藏的 textarea + execCommand 舊方法。回傳是否成功。
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  // onManagerClick(e)：管理視窗內所有按鈕的點擊處理（事件委派）。靠按鈕的 data-act 值用 switch 分派：
  // tab 切換分頁、new 新增、edit 編輯、delete 刪除（會先 confirm 確認）、export 複製 JSON、import-view / import-do 匯入、
  // fill-sample 填範例、test-search / test-detail 測試、save 儲存、back 返回清單。
  function onManagerClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.dataset.act === "toggle") return;
    const act = btn.dataset.act;
    const rule = btn.dataset.id ? findRule(btn.dataset.id) : null;
    switch (act) {
      case "tab":
        managerKind = btn.dataset.kind;
        managerView = "list";
        editing = null;
        renderManager();
        break;
      case "new":
        editing = { kind: managerKind, mode: btn.dataset.mode, enabled: true };
        managerView = "edit";
        renderManager();
        break;
      case "edit":
        if (!rule) return;
        editing = { ...rule };
        managerView = "edit";
        renderManager();
        break;
      case "delete":
        if (!rule || !confirm(`確定要刪除規則「${rule.name}」嗎？`)) return;
        store.rules = store.rules.filter((r) => r.id !== rule.id);
        save();
        toast(`已刪除規則「${rule.name}」`, "bi-trash3-fill text-danger");
        refreshAll();
        break;
      case "export":
        if (!rule) return;
        copyText(JSON.stringify(exportRule(rule), null, 2)).then((ok) =>
          toast(ok ? `已複製「${rule.name}」的規則 JSON` : "複製失敗，請改用編輯畫面手動複製", ok ? "bi-clipboard-check text-success" : "bi-exclamation-triangle text-warning"),
        );
        break;
      case "import-view":
        managerView = "import";
        renderManager();
        break;
      case "import-do":
        doImport();
        break;
      case "fill-sample-import":
        document.getElementById("customRulesImportText").value = JSON.stringify(sampleOf(managerKind), null, 2);
        break;
      case "fill-sample":
        fillForm(sampleOf(editing.kind));
        break;
      case "test-search":
        runTest();
        break;
      case "test-detail":
        runDetailTest(btn.dataset.url);
        break;
      case "save":
        saveEditing();
        break;
      case "back":
        managerView = "list";
        editing = null;
        renderManager();
        break;
    }
  }

  // onManagerChange(e)：啟用 / 停用開關改變時更新規則並儲存（開關是 change 事件，所以和點擊分開處理）。
  function onManagerChange(e) {
    const t = e.target;
    if (t.dataset.act !== "toggle") return;
    const rule = findRule(t.dataset.id);
    if (!rule) return;
    rule.enabled = t.checked;
    save();
    toast(`已${t.checked ? "啟用" : "停用"}規則「${rule.name}」`, t.checked ? "bi-toggle-on text-success" : "bi-toggle-off text-secondary");
    refreshAll();
  }

  // 初始化：載入本機規則、公開 API、綁定全域事件、與伺服器同步。
  // ==================== 初始化 ====================
  loadLocal();
  window.CustomRules = api;

  // 事件委派：不直接綁在按鈕上，而是綁在 document 上再判斷點到誰，這樣 SPA 換頁、按鈕被重新產生也仍然有效。
  // 「自訂規則」按鈕在 SPA 換頁後可能是新的 DOM，用事件委派
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-custom-rules-open]");
    if (btn) openManager(btn.dataset.customRulesOpen);
  });
  // 來源視窗打開時（Bootstrap 的 show.bs.modal 事件）補上跳轉按鈕列。
  // 打開來源 Modal 時補上按鈕列 (例如沒有關鍵字直接打開漫畫來源抽屜)
  document.addEventListener("show.bs.modal", (e) => {
    if (e.target && e.target.id === "kazumiSourceModal") renderJumpRow("anime");
    if (e.target && e.target.id === "mangaSourceModal") renderJumpRow("manga");
    if (e.target && e.target.id === "novelSourceModal") {
      renderJumpRow("novel");
      if (typeof window.updateNovelSourcePills === "function") window.updateNovelSourcePills();
    }
  });
  // storage 事件：另一個瀏覽器分頁改了 localStorage 時觸發，這裡重新讀取並更新畫面，多分頁保持一致。
  // 其他分頁改了規則時同步
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    loadLocal();
    refreshAll();
  });

  // 頁面還在載入就等 DOMContentLoaded 再與伺服器同步；已載入完就直接同步。
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncFromServer);
  else syncFromServer();
})();
