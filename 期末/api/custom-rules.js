/**
 * Web Library - 使用者自訂規則爬取引擎 (動畫：Kazumi 規則格式 / 漫畫：仿 Kazumi 的 XPath 規則)
 * 規則由前端隨請求帶上 (存在使用者自己的 localStorage / 帳號同步)，伺服器不保存、只負責安全抓取與解析。
 */
const { safeFetchText } = require('./safe-fetch');
const { parseHtml, select, selectText, selectLink } = require('./xpath-lite');

const MAX_RESULTS = 60;
const MAX_EPISODES = 2000;
const MAX_PAGES = 500;

const ANIME_FIELDS = ['searchURL', 'searchList', 'searchName', 'searchResult', 'chapterRoads', 'chapterResult'];
const MANGA_FIELDS = ['searchURL', 'searchList', 'searchName', 'searchResult', 'searchCover', 'chapterList', 'chapterResult', 'pageImage'];

function str(v, max = 2000) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

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

function requestHeaders(rule) {
    const h = {};
    if (rule.userAgent) h['User-Agent'] = rule.userAgent;
    const ref = rule.referer || rule.baseURL;
    if (ref) h['Referer'] = ref;
    return h;
}

function absUrl(href, base) {
    if (!href) return '';
    href = href.trim();
    if (/^(javascript|data|mailto):/i.test(href)) return '';
    try { return new URL(href, base).toString(); } catch (e) { return ''; }
}

async function fetchDoc(url, rule, extra = {}) {
    // extra 放前面：extra.headers (例如 usePost 的 Content-Type) 要和規則的 UA / Referer 合併，不能整個蓋掉
    const res = await safeFetchText(url, { ...extra, headers: { ...requestHeaders(rule), ...(extra.headers || {}) } });
    if (res.status >= 400) throw new Error(`目標網站回應 HTTP ${res.status}`);
    return { doc: parseHtml(res.text), url: res.url, html: res.text };
}

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

const IMG_ATTRS = ['data-original', 'data-src', 'data-lazy-src', 'data-echo', 'data-url', 'src'];

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

// ==================== 動畫 (Kazumi 規則) ====================
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
    // 2. 原始碼裡直接出現的 m3u8 / mp4 (含跳脫的 \/)
    const direct = pickMedia(html);
    if (direct) return { playerUrl: absUrl(direct, pageUrl), isDirectStream: true };
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
    // 4. 找不到：交給前端顯示「另開新分頁」
    return { playerUrl: pageUrl, isDirectStream: false, isBlockedIframe: true };
}

// ==================== 漫畫 (仿 Kazumi 的 XPath 規則) ====================
function proxied(img, referer) {
    if (!img) return '';
    return `/api/manga/proxy?url=${encodeURIComponent(img)}${referer ? `&ref=${encodeURIComponent(referer)}` : ''}`;
}

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

module.exports = { animeSearch, animeEpisodes, animePlay, mangaSearch, mangaChapters, mangaPages, normalizeRule };
