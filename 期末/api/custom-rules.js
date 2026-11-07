// 【總說明】api/custom-rules.js：「自訂規則」的後端爬蟲引擎（純函式庫，沒有自己的路由）。
// 使用者可以自己寫規則（網址模板 + XPath），讓網站去別的動漫 / 漫畫網站搜尋、抓章節、抓圖片。
// 配合關係：
//  - 前端 js/custom-rules.js 管理規則，呼叫時把整份規則隨請求送來
//  - api/kazumi.js、api/manga.js 的自訂規則路由 require 這支檔案的 animeXxx / mangaXxx 函式
//  - 抓網頁一律走 safe-fetch.js（防 SSRF），解析 HTML 用 xpath-lite.js 的 XPath
// 共同流程：normalizeRule 清理規則 -> fetchDoc 抓並解析網頁 -> select 用 XPath 取出節點 -> 組成結果回傳。
// 伺服器不保存規則，每次都由前端帶上來。
/**
 * Web Library - 使用者自訂規則爬取引擎 (動畫：Kazumi 規則格式 / 漫畫：仿 Kazumi 的 XPath 規則)
 * 規則由前端隨請求帶上 (存在使用者自己的 localStorage / 帳號同步)，伺服器不保存、只負責安全抓取與解析。
 */
const { safeFetchText } = require('./safe-fetch');
const { parseHtml, select, selectText, selectLink } = require('./xpath-lite');

// 安全上限，避免對方網站回傳超大量資料拖垮伺服器：搜尋結果 60 筆、集數 2000、漫畫頁數 500。
const MAX_RESULTS = 60;
const MAX_EPISODES = 2000;
const MAX_PAGES = 500;

// 規則允許的欄位白名單（動畫 / 漫畫各一份）。不在名單裡的欄位會被忽略。
// 欄位意思：searchURL=搜尋網址(含 @keyword)、searchList=結果清單 XPath、searchName=標題、searchResult=詳情連結、
// chapterRoads=播放線路區塊、chapterResult=集數連結、searchCover=封面、chapterList=章節清單區塊、pageImage=漫畫圖片。
const ANIME_FIELDS = ['searchURL', 'searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult'];
const MANGA_FIELDS = ['searchURL', 'searchList', 'searchName', 'searchResult', 'searchCover', 'chapterList', 'chapterResult', 'pageImage'];

// str(v, max)：安全取字串。不是字串就回傳空字串；是字串就去頭尾空白並截到最大長度 max（預設 2000）。
function str(v, max = 2000) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// normalizeRule(raw, kind)：驗證並清理前端傳來的規則。
//  參數：raw 原始規則物件；kind 為 'anime' 或 'manga'（決定要讀哪些欄位）。
//  回傳：乾淨的規則物件；缺少必要欄位時丟 Error（呼叫端會轉成錯誤訊息給前端）。
//  目的：前端傳來的資料不可信，只取已知欄位並限制長度，避免奇怪輸入。
// 只取需要的欄位並限制長度，避免奇怪的輸入
function normalizeRule(raw, kind) {
    if (!raw || typeof raw !== 'object') throw new Error('缺少規則內容');
    const rule = {
        name: str(raw.name, 80) || '自訂規則',
        baseURL: str(raw.baseURL, 500),
        userAgent: str(raw.userAgent, 400),
        referer: str(raw.referer, 500),
        usePost: raw.usePost === true || raw.usePost === 'true',
        chapterReverse: raw.chapterReverse === true || raw.chapterReverse === 'true'
    };
    for (const f of kind === 'manga' ? MANGA_FIELDS : ANIME_FIELDS) rule[f] = str(raw[f]);
    if (!rule.searchURL) throw new Error('規則缺少 searchURL');
    if (!rule.searchList || !rule.searchName || !rule.searchResult) throw new Error('規則缺少 searchList / searchName / searchResult');
    return rule;
}

// requestHeaders(rule)：依規則組出 HTTP 標頭。可自訂 User-Agent；
// Referer（來源頁）若沒填就用 baseURL，很多網站會檢查 Referer 來防盜連。
function requestHeaders(rule) {
    const h = {};
    if (rule.userAgent) h['User-Agent'] = rule.userAgent;
    const ref = rule.referer || rule.baseURL;
    if (ref) h['Referer'] = ref;
    return h;
}

// absUrl(href, base)：把相對網址（如 /video/1）轉成完整網址。
// 安全：javascript: / data: / mailto: 開頭的一律丟掉（避免被塞進惡意連結）；轉換失敗回傳空字串。
function absUrl(href, base) {
    if (!href) return '';
    href = href.trim();
    if (/^(javascript|data|mailto):/i.test(href)) return '';
    try { return new URL(href, base).toString(); } catch (e) { return ''; }
}

// fetchDoc(url, rule, extra)：抓網頁並解析成可用 XPath 查詢的文件。
//  回傳 { doc: 解析後文件, url: 最終網址(可能經轉址), html: 原始文字 }。HTTP 狀態 >= 400 就丟錯。
async function fetchDoc(url, rule, extra = {}) {
    // extra 放前面：extra.headers (例如 usePost 的 Content-Type) 要和規則的 UA / Referer 合併，不能整個蓋掉
    const res = await safeFetchText(url, { ...extra, headers: { ...requestHeaders(rule), ...(extra.headers || {}) } });
    if (res.status >= 400) throw new Error(`目標網站回應 HTTP ${res.status}`);
    return { doc: parseHtml(res.text), url: res.url, html: res.text };
}

// fetchSearchDoc(rule, keyword)：執行搜尋。
// 把 searchURL 裡的 @keyword 換成編碼後的關鍵字（encodeURIComponent 處理中文與特殊字元）。
// 若規則設 usePost：有些網站要用 POST 搜尋，這裡把網址的 ?query 部分取出當成 POST 表單內容，網址本身去掉 query 再送出。
// Kazumi 的 usePost：searchURL 的查詢字串當成 POST 表單內容送出
async function fetchSearchDoc(rule, keyword) {
    const filled = rule.searchURL.replace(/@keyword/g, encodeURIComponent(keyword));
    if (!rule.usePost) return fetchDoc(filled, rule);
    const u = new URL(filled);
    const body = u.searchParams.toString();
    u.search = '';
    return fetchDoc(u.toString(), rule, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
}

// 圖片網址可能放在的屬性。很多網站用「懶載入」，真正網址在 data-original / data-src，src 只是占位圖，所以 src 排最後。
const IMG_ATTRS = ['data-original', 'data-src', 'data-lazy-src', 'data-echo', 'data-url', 'src'];

// imageFrom(node)：從節點找出圖片網址。依序嘗試：
//  屬性節點 -> 文字節點 -> 元素的各種圖片屬性（跳過 gif/svg 占位小圖）-> style 的 background-image:url(...) -> 遞迴找裡面第一個 <img>。
//  找不到回傳空字串。
function imageFrom(node) {
    if (!node) return '';
    if (node.type === 'attr') return node.value;
    if (node.type === 'text') return node.text.trim();
    if (node.attrs) {
        for (const a of IMG_ATTRS) {
            const v = node.attrs[a];
            if (v && !/^data:image\/(gif|svg)/i.test(v)) return v;
        }
        const style = node.attrs.style || '';
        const bg = /url\(\s*['"]?([^'")]+)/i.exec(style);
        if (bg) return bg[1];
    }
    const inner = select(node, './/img');
    return inner.length ? imageFrom(inner[0]) : '';
}

// 動畫 (Kazumi 規則) 的三個步驟：搜尋 -> 取集數 -> 取得播放連結。
// ==================== 動畫 (Kazumi 規則) ====================
// animeSearch(rawRule, keyword)：搜尋動畫。
//  參數：rawRule 前端傳來的規則；keyword 關鍵字。回傳 { results:[{title,detailUrl,cover,source}], matched:命中節點數 }。
//  作法：用 searchList 取出每個結果區塊，再在區塊內用 searchName / searchResult 取標題與連結；
//  用 Set (seen) 依詳情網址去重，標題或連結缺少的略過。
async function animeSearch(rawRule, keyword) {
    const rule = normalizeRule(rawRule, 'anime');
    const { doc, url } = await fetchSearchDoc(rule, keyword);
    const base = rule.baseURL || url;
    const items = select(doc, rule.searchList).filter(n => n.type === 'el').slice(0, MAX_RESULTS);
    const results = [];
    const seen = new Set();
    for (const item of items) {
        const title = selectText(item, rule.searchName);
        const detailUrl = absUrl(selectLink(item, rule.searchResult), base);
        if (!title || !detailUrl || seen.has(detailUrl)) continue;
        seen.add(detailUrl);
        const cover = absUrl(imageFrom(select(item, './/img')[0]), base);
        results.push({ title, detailUrl, cover, source: rule.name });
    }
    return { results, matched: items.length };
}

// animeEpisodes(rawRule, detailUrl)：取得某部動畫的集數列表。
//  回傳陣列 [{title, playUrl, line, epIndex}]。chapterRoads 代表「播放線路」（一部動畫可能有多條線路），
//  每條線路內再用 chapterResult 取各集連結。只有一條線路時直接回傳；多條時標題前加 [線路N] 區分。
async function animeEpisodes(rawRule, detailUrl) {
    const rule = normalizeRule(rawRule, 'anime');
    if (!rule.chapterRoads || !rule.chapterResult) throw new Error('規則缺少 chapterRoads / chapterResult');
    const { doc, url } = await fetchDoc(detailUrl, rule);
    const roads = select(doc, rule.chapterRoads).filter(n => n.type === 'el');
    const roadLists = [];
    for (const road of roads) {
        const eps = [];
        for (const a of select(road, rule.chapterResult)) {
            const href = a.type === 'attr' ? a.value : (a.attrs && a.attrs.href) || selectLink(a, '.');
            const playUrl = absUrl(href, url);
            const name = a.type === 'el' ? selectText(a, '.') : '';
            if (playUrl) eps.push({ title: name || `第 ${eps.length + 1} 集`, playUrl });
            if (eps.length >= MAX_EPISODES) break;
        }
        if (eps.length) roadLists.push(eps);
    }
    if (roadLists.length <= 1) return (roadLists[0] || []).map((e, i) => ({ ...e, line: '1', epIndex: i + 1 }));
    // 多條播放線路：標上線路編號一起列出
    const out = [];
    roadLists.forEach((list, r) => list.forEach((e, i) => out.push({ ...e, title: `[線路${r + 1}] ${e.title}`, line: String(r + 1), epIndex: i + 1 })));
    return out.slice(0, MAX_EPISODES);
}

// pickMedia(text)：在文字中用正規表示式找影片直連。
//  正規表示式意思：(可有 http:) + // + 非空白/引號字元 + .m3u8 或 .mp4 + 可選的 ?參數。
//  先把 JSON 跳脫的 \/ 還原成 /；檔名含 ad、ads、poster、logo、preroll 等視為廣告或海報而跳過；
//  m3u8（串流播放清單）分數比 mp4 高，優先使用。回傳最佳網址，找不到回傳空字串。
// 從原始碼挑出最像正片的直連：m3u8 優先，略過廣告 / 片頭海報
function pickMedia(text) {
    const re = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
    const found = [];
    let m;
    const src = text.replace(/\\\//g, '/');
    while ((m = re.exec(src)) !== null) {
        const file = m[0].split('?')[0].split('/').pop() || '';
        if (/(^|[^a-z])(ad|ads|adv|poster|logo|loading|preroll)([^a-z]|$)|adposter/i.test(file)) continue;
        found.push({ url: m[0], score: m[1].toLowerCase() === 'm3u8' ? 2 : 1 });
    }
    found.sort((a, b) => b.score - a.score);
    return found.length ? found[0].url : '';
}

// animePlay(rawRule, playUrl)：嘗試從播放頁找出可直接播放的影片網址。
//  回傳 { playerUrl, isDirectStream(是否為可直接播放的串流), isBlockedIframe(是否需另開分頁) }。
//  因為伺服器不能像 Kazumi App 用 WebView 偷看實際網路請求，只能用下面四招猜；全失敗就叫前端另開新分頁。
// Kazumi 本身是用 WebView 嗅探影片；這裡只能盡量從原始碼找直連，找不到就讓前端改用外開
async function animePlay(rawRule, playUrl) {
    const rule = normalizeRule(rawRule, 'anime');
    let html = '';
    let pageUrl = playUrl;
    try {
        const res = await fetchDoc(playUrl, rule);
        html = res.html;
        pageUrl = res.url;
    } catch (e) {
        return { playerUrl: playUrl, isDirectStream: false, isBlockedIframe: true, reason: e.message };
    }

    // 招式 1：許多影視站用 MacCMS 系統，會把播放資訊放在 player_aaaa = {...} 這個變數。
    //  encrypt 為 1 表示網址被 escape 編碼，為 2 表示先 base64 再 escape，所以要解碼才得到真實網址。
    // 1. MacCMS 常見的 player_aaaa 變數
    const aaaa = /player_[a-z]{4}\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i.exec(html);
    if (aaaa) {
        try {
            const data = JSON.parse(aaaa[1]);
            let real = data.url || '';
            if (data.encrypt == 1) real = unescape(real);
            else if (data.encrypt == 2) real = unescape(Buffer.from(real, 'base64').toString('utf8'));
            if (/\.(m3u8|mp4)(\?|$)/i.test(real)) return { playerUrl: absUrl(real, pageUrl), isDirectStream: true };
        } catch (_) {}
    }
    // 招式 2：直接在整頁原始碼中找 m3u8 / mp4。
    // 2. 原始碼裡直接出現的 m3u8 / mp4 (含跳脫的 \/)
    const direct = pickMedia(html);
    if (direct) return { playerUrl: absUrl(direct, pageUrl), isDirectStream: true };
    // 招式 3：找內嵌播放器 <iframe>。網址參數 url= / v= / vid= 常直接帶著影片網址；
    //  沒有的話再多抓一層 iframe 頁面來找（上限 7 秒、1MB，避免卡住）。
    // 3. 播放器 iframe 的 url= 參數
    const iframe = /<iframe[^>]+src=["']([^"']+)["']/i.exec(html);
    if (iframe) {
        const src = absUrl(iframe[1].replace(/&amp;/g, '&'), pageUrl);
        const inner = /[?&](?:url|v|vid)=([^&]+\.(?:m3u8|mp4)[^&]*)/i.exec(src);
        if (inner) return { playerUrl: absUrl(decodeURIComponent(inner[1]), pageUrl), isDirectStream: true };
        if (src) {
            // 再往播放器頁面多看一層 (很多解析器把直連寫在 var url = '...m3u8')
            try {
                const sub = await safeFetchText(src, { headers: { ...requestHeaders(rule), Referer: pageUrl }, timeoutMs: 7000, maxBytes: 1024 * 1024 });
                const hit = pickMedia(sub.text);
                if (hit) return { playerUrl: absUrl(hit, src), isDirectStream: true };
            } catch (_) {}
            return { playerUrl: src, isDirectStream: false, isBlockedIframe: false };
        }
    }
    // 招式 4：都找不到，回傳原頁面網址，由前端提示使用者另開新分頁觀看。
    // 4. 找不到：交給前端顯示「另開新分頁」
    return { playerUrl: pageUrl, isDirectStream: false, isBlockedIframe: true };
}

// 漫畫 (仿 Kazumi 的 XPath 規則)：搜尋 -> 章節 -> 頁面圖片。
// ==================== 漫畫 (仿 Kazumi 的 XPath 規則) ====================
// proxied(img, referer)：把圖片網址包成本站的代理網址 /api/manga/proxy?url=...&ref=...。
//  為什麼：漫畫站的圖片通常會檢查 Referer（防盜連），瀏覽器直接載入會被擋，
//  所以改由本站伺服器代抓（帶正確 Referer）再轉給瀏覽器。encodeURIComponent 避免網址中的 & ? 破壞參數。
function proxied(img, referer) {
    if (!img) return '';
    return `/api/manga/proxy?url=${encodeURIComponent(img)}${referer ? `&ref=${encodeURIComponent(referer)}` : ''}`;
}

// mangaSearch(rawRule, keyword)：搜尋漫畫，邏輯同 animeSearch，另外多取封面（searchCover 或第一張 img）並走代理。
//  回傳 { results, matched }。
async function mangaSearch(rawRule, keyword) {
    const rule = normalizeRule(rawRule, 'manga');
    const { doc, url } = await fetchSearchDoc(rule, keyword);
    const base = rule.baseURL || url;
    const ref = rule.referer || rule.baseURL || url;
    const items = select(doc, rule.searchList).filter(n => n.type === 'el').slice(0, MAX_RESULTS);
    const results = [];
    const seen = new Set();
    for (const item of items) {
        const title = selectText(item, rule.searchName);
        const detailUrl = absUrl(selectLink(item, rule.searchResult), base);
        if (!title || !detailUrl || seen.has(detailUrl)) continue;
        seen.add(detailUrl);
        const coverNode = rule.searchCover ? select(item, rule.searchCover)[0] : select(item, './/img')[0];
        const cover = absUrl(imageFrom(coverNode), base);
        results.push({ title, detailUrl, cover: proxied(cover, ref), source: rule.name });
    }
    return { results, matched: items.length };
}

// mangaChapters(rawRule, detailUrl)：取漫畫章節列表。回傳 [{id(章節網址), title, index}]。
//  chapterList 是選填的章節容器；沒填就整份文件都找。依連結去重；chapterReverse 為真時反轉順序（有些網站最新章在最前面）。
async function mangaChapters(rawRule, detailUrl) {
    const rule = normalizeRule(rawRule, 'manga');
    if (!rule.chapterResult) throw new Error('規則缺少 chapterResult');
    const { doc, url } = await fetchDoc(detailUrl, rule);
    const containers = rule.chapterList ? select(doc, rule.chapterList).filter(n => n.type === 'el') : [doc];
    const chapters = [];
    const seen = new Set();
    for (const box of containers) {
        for (const a of select(box, rule.chapterResult)) {
            const href = a.type === 'attr' ? a.value : (a.attrs && a.attrs.href) || selectLink(a, '.');
            const link = absUrl(href, url);
            if (!link || seen.has(link)) continue;
            seen.add(link);
            const title = a.type === 'el' ? (selectText(a, '.') || (a.attrs && a.attrs.title) || '') : '';
            chapters.push({ id: link, title: title || `第 ${chapters.length + 1} 話` });
            if (chapters.length >= MAX_EPISODES) break;
        }
    }
    if (rule.chapterReverse) chapters.reverse();
    return chapters.map((c, i) => ({ ...c, index: i + 1 }));
}

// mangaPages(rawRule, chapterUrl)：取某一章的所有圖片。回傳「已包成代理網址」的圖片網址陣列。
//  pageImage 沒填就預設抓所有 <img>（//img）；依網址去重，最多 500 張。
async function mangaPages(rawRule, chapterUrl) {
    const rule = normalizeRule(rawRule, 'manga');
    const { doc, url } = await fetchDoc(chapterUrl, rule);
    const nodes = select(doc, rule.pageImage || '//img');
    const pages = [];
    const seen = new Set();
    for (const n of nodes) {
        const img = absUrl(imageFrom(n), url);
        if (!img || seen.has(img)) continue;
        seen.add(img);
        pages.push(proxied(img, rule.referer || url));
        if (pages.length >= MAX_PAGES) break;
    }
    return pages;
}

// 對外匯出給 kazumi.js / manga.js 的自訂規則路由使用。
module.exports = { animeSearch, animeEpisodes, animePlay, mangaSearch, mangaChapters, mangaPages, normalizeRule };
