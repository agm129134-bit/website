// 【總說明】api/novel.js：線上小說（日本小說）的後端。server.js 會把 /api/novel/* 的請求交給 handleNovelRoute。
// 做法：伺服器代替瀏覽器去「小説家になろう」和「カクヨム」抓公開網頁，整理成統一的 JSON 格式給前端，
// 前端就不用處理跨網域（CORS）與兩個網站格式不同的問題。
// 結構：
//  1. 共用工具（sendJson 回應、fetchRemote 抓網頁、toParagraphs 切段落、cached 快取）
//  2. 兩個書源物件 syosetu / kakuyomu，都有相同介面：search(搜尋)、chapters(章節目錄)、content(章節正文)
//  3. handleNovelRoute：解析網址、挑書源、驗證參數、呼叫書源並回傳 JSON
// 這樣新增書源只要照同樣介面再寫一個物件即可。
/**
 * Web Library - 小說線上書源後端 (/api/novel)
 *
 * 只提供日本小說，兩個書源皆為作者自行免費公開、免登入：
 *   - syosetu  : 小説家になろう (官方 API 搜尋 + ncode.syosetu.com 公開頁面)
 *   - kakuyomu : カクヨム (kakuyomu.jp 頁面內嵌的 Next.js 公開資料)
 *
 * 端點：
 *   GET /api/novel/search?q=&source=
 *   GET /api/novel/chapters?novelId=&source=
 *   GET /api/novel/content?novelId=&chapterId=&source=
 * 失敗時回傳 { success:false, unavailable:true, error } 讓前端顯示「書源暫時無法連線」。
 */

// 偽裝成一般瀏覽器的 User-Agent；TIMEOUT_MS 為單次請求逾時 10 秒；DEFAULT_SOURCE 是沒指定書源時的預設。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 10000;
const DEFAULT_SOURCE = 'syosetu';

// ---------- 共用工具 ----------

// sendJson(res, statusCode, payload)：統一的 JSON 回應函式。
//  參數：res 回應物件、statusCode HTTP 狀態碼、payload 要轉成 JSON 的物件。
//  若回應已結束 (writableEnded) 就不再寫，避免重複回應造成錯誤。同時加上 CORS 標頭。
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

// 自訂錯誤：代表「書源網站那邊出問題」（連不上、格式變了），路由會轉成 502 並提示書源暫時無法連線，
// 和程式本身的 bug (500) 區分開。
class SourceError extends Error {}

// fetchRemote(url, 選項)：抓遠端網頁文字。
//  選項：method、body、encoding(解碼用，預設 utf-8)、headers。回傳 { url: 最終網址, text }。
//  用內建 fetch，AbortSignal.timeout 設逾時；逾時 / 連不上 / 非 2xx 都丟 SourceError。
//  先拿 arrayBuffer 再自己用 TextDecoder 解碼，才能指定編碼。
// 抓取遠端頁面，逾時或非 2xx 一律丟 SourceError
async function fetchRemote(url, { method = 'GET', body, encoding = 'utf-8', headers = {} } = {}) {
    let resp;
    try {
        resp = await fetch(url, {
            method,
            body,
            headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8', ...headers },
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (err) {
        const reason = err.name === 'TimeoutError' ? '連線逾時' : '無法連線';
        throw new SourceError(`${reason} (${new URL(url).host})`);
    }
    if (!resp.ok) throw new SourceError(`書源回應 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return { url: resp.url, text: new TextDecoder(encoding).decode(buf) };
}

// decodeEntities(s)：把 HTML 實體碼（&lt; &amp; &#39; 等）還原成真正字元。
//  注意 &amp; 要最後才換，否則像 &amp;lt; 會被錯誤地二次還原。
function decodeEntities(s) {
    return String(s || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&');
}

// stripTags(s)：去掉所有 <...> 標籤、還原實體碼、去頭尾空白，得到純文字。
const stripTags = s => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).trim();

// toParagraphs(html)：把小說正文的 HTML 轉成「段落字串陣列」。
//  步驟：移除 <script> -> 移除振假名（<rt> 注音、<rp> 括號，只留漢字）-> 依 <br> 或 </p> 切段
//  -> 去標籤 -> 去掉全形 / 半形空白 -> 濾掉空段落。
// HTML 片段 → 段落陣列
function toParagraphs(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<rp>[\s\S]*?<\/rp>|<rt>[\s\S]*?<\/rt>/gi, '') // 去掉振假名，只留漢字本體
        .split(/<br\s*\/?>|<\/p>/i)
        .map(stripTags)
        .map(s => s.replace(/^[\s　]+|[\s　]+$/g, ''))
        .filter(Boolean);
}

// 簡易快取：章節目錄要抓很多頁，同一部小說翻章時不用重抓。
//  cached(key, loader)：key 命中且未過期（10 分鐘）就直接回傳；否則執行 loader 取得資料並存起來。
//  Map 會保持插入順序，超過 50 筆就刪掉最舊的那筆（最簡單的 FIFO 淘汰）。快取在記憶體，重啟就清空。
// 小型記憶體快取 (章節目錄較大，避免每次翻章都重抓)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 50;
async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
    const v = await loader();
    cache.set(key, { t: Date.now(), v });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
}

// readApolloState(html)：カクヨム 是 Next.js 網站，頁面裡的 <script id="__NEXT_DATA__"> 內含整份 JSON 資料，
//  其中 __APOLLO_STATE__ 是 GraphQL 快取（作品、章節的資料都在這），比解析 HTML 穩定。找不到或解析失敗丟 SourceError。
// Next.js 頁面內嵌的 Apollo 快取 (カクヨム 使用)
function readApolloState(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new SourceError('頁面格式異常');
    try {
        return JSON.parse(m[1]).props.pageProps.__APOLLO_STATE__ || {};
    } catch {
        throw new SourceError('頁面資料解析失敗');
    }
}

// 書源 1：小説家になろう。搜尋用官方 API，目錄與正文則解析公開頁面。
// ---------- 書源：小説家になろう syosetu (官方 API + 公開頁面) ----------
// novelId 為 ncode (如 n0147mz)；chapterId 為話數，短篇以 "0" 表示整篇

const SYOSETU_API = 'https://api.syosetu.com/novelapi/api/';
const SYOSETU = 'https://ncode.syosetu.com';
const SYOSETU_GENRES = {
    101: '異世界〔恋愛〕', 102: '現実世界〔恋愛〕', 201: 'ハイファンタジー', 202: 'ローファンタジー',
    301: '純文学', 302: 'ヒューマンドラマ', 303: '歴史', 304: '推理', 305: 'ホラー', 306: 'アクション', 307: 'コメディー',
    401: 'VRゲーム', 402: '宇宙', 403: '空想科学', 404: 'パニック', 9901: '童話', 9902: '詩', 9903: 'エッセイ', 9904: 'リプレイ', 9999: 'その他'
};
// validNovelId：驗證作品編號格式（n + 4 位數字 + 1~3 個小寫字母）；防止使用者亂塞字串拼進網址。
const syosetu = {
    name: '小説家になろう',
    validNovelId: id => /^n\d{4}[a-z]{1,3}$/.test(id),

    // search(q)：搜尋。回傳統一格式陣列 [{id,title,author,category,status,cover,intro,chapterCount}]。
    async search(q) {
        // order=hyoka 依評價排序；title/wname/keyword=1 表示只比對標題、作者、關鍵字；of= 指定回傳哪些欄位。
        //  API 回傳陣列的第 0 筆是統計資訊（總筆數），所以後面用 slice(1) 跳過。
        // 依總合評價排序，只比對標題 / 作者 / 關鍵字，減少雜訊
        const params = new URLSearchParams({
            out: 'json', lim: '30', order: 'hyoka', word: q,
            title: '1', wname: '1', keyword: '1', of: 't-n-w-s-g-nt-e-ga'
        });
        const { text } = await fetchRemote(`${SYOSETU_API}?${params}`, { headers: { 'Accept-Language': 'ja' } });
        let list;
        try { list = JSON.parse(text); } catch { throw new SourceError('搜尋結果格式異常'); }
        if (!Array.isArray(list)) throw new SourceError('搜尋結果格式異常');
        return list.slice(1).filter(n => n && n.ncode).map(n => ({
            id: String(n.ncode).toLowerCase(),
            title: n.title || '',
            author: n.writer || '',
            category: SYOSETU_GENRES[n.genre] || '',
            status: n.noveltype === 2 ? '短篇' : (n.end === 0 ? '完結' : '連載'),
            cover: '',
            intro: String(n.story || '').replace(/\s+/g, ' ').slice(0, 200),
            chapterCount: n.noveltype === 2 ? 1 : n.general_all_no
        }));
    },

    // chapters(id)：取章節目錄，回傳 [{id, title, volumeTitle}]。用 cached 包起來避免重抓。
    async chapters(id) {
        return cached(`syosetu:${id}`, async () => {
            const first = (await fetchRemote(`${SYOSETU}/${id}/`)).text;
            // 短篇小說沒有目錄頁，整篇就在作品頁，用 id '0' 代表。
            // 短篇沒有目錄，整篇就在作品頁
            if (!first.includes('p-eplist__subtitle')) {
                const title = stripTags((first.match(/<h1 class="p-novel__title[^"]*">([\s\S]*?)<\/h1>/) || [])[1]) || '本文';
                return [{ id: '0', title }];
            }
            // 目錄分頁（每頁 100 話）：從「最後一頁」按鈕的連結讀出總頁數，最多抓 30 頁避免無限抓取；
            //  再依序抓每一頁（用 for + await，一頁一頁來，對對方網站比較客氣）。
            // 目錄每頁 100 話，最多讀 30 頁 (3000 話)
            const lastPage = Math.min(30, Number((first.match(/href="\/[a-z0-9]+\/\?p=(\d+)" class="c-pager__item c-pager__item--last"/) || [])[1]) || 1);
            const pages = [first];
            for (let p = 2; p <= lastPage; p++) pages.push((await fetchRemote(`${SYOSETU}/${id}/?p=${p}`)).text);

            const chapters = [];
            let volumeTitle = '';
            for (const html of pages) {
                // 一個正規表示式同時匹配兩種元素：<div class="p-eplist__chapter-title">（卷 / 篇標題）和 <a ... class="p-eplist__subtitle">（各話連結）。
                //  /g 搭配 exec 迴圈逐一取出；遇到卷標題就記下來，之後的話數都歸在這個卷底下。
                const re = /<div class="p-eplist__chapter-title">([\s\S]*?)<\/div>|<a href="\/[a-z0-9]+\/(\d+)\/" class="p-eplist__subtitle">([\s\S]*?)<\/a>/g;
                let m;
                while ((m = re.exec(html))) {
                    if (m[1] !== undefined) volumeTitle = stripTags(m[1]);
                    else chapters.push({ id: m[2], title: stripTags(m[3]), volumeTitle });
                }
            }
            return chapters;
        });
    },

    // content(id, chapterId)：取某一話正文，回傳 { title, paragraphs[] }。
    //  正文分成 前書き / 本文 / 後書き 多個區塊，全部抓出來接在一起。
    async content(id, chapterId) {
        const url = chapterId === '0' ? `${SYOSETU}/${id}/` : `${SYOSETU}/${id}/${chapterId}/`;
        const { text } = await fetchRemote(url);
        const title = stripTags((text.match(/<h1 class="p-novel__title[^"]*">([\s\S]*?)<\/h1>/) || [])[1]);
        // 前書き / 本文 / 後書き 各是一個 js-novel-text 區塊
        const blocks = [...text.matchAll(/<div class="js-novel-text p-novel__text[^"]*">([\s\S]*?)<\/div>/g)].map(m => m[1]);
        return { title, paragraphs: blocks.flatMap(toParagraphs) };
    }
};

// 書源 2：カクヨム。資料來自頁面內嵌的 Next.js / Apollo 資料。
// ---------- 書源：カクヨム kakuyomu (頁面內嵌的公開資料) ----------
// novelId 為作品 ID，chapterId 為 episode ID (皆為長數字)

const KAKUYOMU = 'https://kakuyomu.jp';
const KAKUYOMU_GENRES = {
    FANTASY: '異世界ファンタジー', ACTION: '現代ファンタジー', SF: 'SF', LOVE_STORY: '恋愛', ROMANCE: 'ラブコメ',
    DRAMA: '現代ドラマ', HORROR: 'ホラー', MYSTERY: 'ミステリー', HISTORY: '歴史・時代・伝奇',
    NONFICTION: 'エッセイ・ノンフィクション', CRITICISM: '創作論・評論', OTHERS: '詩・童話・その他'
};
// validNovelId：作品 ID 為 6~20 位純數字。
const kakuyomu = {
    name: 'カクヨム',
    validNovelId: id => /^\d{6,20}$/.test(id),

    async search(q) {
        const { text } = await fetchRemote(`${KAKUYOMU}/search?q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'ja' } });
        const state = readApolloState(text);
        // ref(r)：Apollo 快取裡物件常用 { __ref: 'Work:123' } 指向別的項目，這個小函式負責「跟著指標取出真正的資料」。
        const ref = r => (r && r.__ref ? state[r.__ref] : r) || {};
        // 優先用搜尋結果 (searchWorks...) 的順序；萬一取不到，退而求其次，把快取裡所有 Work: 開頭的項目都拿來用。
        // 依搜尋結果的排序取作品，取不到就退回快取中所有作品
        const root = state.ROOT_QUERY || {};
        const rootKey = Object.keys(root).find(k => k.startsWith('searchWorks'));
        const nodes = rootKey && root[rootKey] && Array.isArray(root[rootKey].nodes) ? root[rootKey].nodes.map(ref) : [];
        const works = nodes.length ? nodes : Object.keys(state).filter(k => k.startsWith('Work:')).map(k => state[k]);
        return works.filter(w => w && w.id && w.title).slice(0, 30).map(w => ({
            id: String(w.id),
            title: w.title,
            author: w.alternateAuthorName || ref(w.author).activityName || '',
            category: KAKUYOMU_GENRES[w.genre] || '',
            status: w.serialStatus === 'COMPLETED' ? '完結' : '連載',
            cover: w.adminCoverImageUrl || '',
            intro: [w.catchphrase, w.introduction].filter(Boolean).join('｜').replace(/\s+/g, ' ').slice(0, 200),
            chapterCount: w.publicEpisodeCount
        }));
    },

    // chapters(id)：從作品頁的目錄資料 (tableOfContentsV2) 取出所有章節；每個卷 (chapter) 底下有多個 episode。
    async chapters(id) {
        return cached(`kakuyomu:${id}`, async () => {
            const { text } = await fetchRemote(`${KAKUYOMU}/works/${id}`);
            const state = readApolloState(text);
            const work = state[`Work:${id}`];
            if (!work) throw new SourceError('找不到這部作品');
            const ref = r => (r && r.__ref ? state[r.__ref] : r) || {};
            const chapters = [];
            for (const tocRef of work.tableOfContentsV2 || []) {
                const toc = ref(tocRef);
                const volumeTitle = ref(toc.chapter).title || '';
                for (const epRef of toc.episodeUnions || []) {
                    const ep = ref(epRef);
                    if (ep.id) chapters.push({ id: String(ep.id), title: ep.title || '', volumeTitle });
                }
            }
            return chapters;
        });
    },

    // content(id, chapterId)：抓單話頁面，用正規表示式取標題與正文區塊，再切成段落。
    async content(id, chapterId) {
        const { text } = await fetchRemote(`${KAKUYOMU}/works/${id}/episodes/${chapterId}`);
        const title = stripTags((text.match(/<p class="widget-episodeTitle[^"]*">([\s\S]*?)<\/p>/) || [])[1]);
        const body = (text.match(/<div class="widget-episodeBody[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
        return { title, paragraphs: toParagraphs(body) };
    }
};

// 書源登記表：query 的 source 參數對應到這裡的物件。
const SOURCES = { syosetu, kakuyomu };

// handleNovelRoute(req, res)：/api/novel 的路由處理器（全部 GET）。
//  /api/novel/search?q=&source=                      搜尋
//  /api/novel/chapters?novelId=&source=              章節目錄
//  /api/novel/content?novelId=&chapterId=&source=    章節正文
//  回傳 JSON：成功 { success:true, ... }；參數錯 400；書源出問題 502（unavailable:true）；程式錯誤 500；路徑不存在 404。
// ---------- 路由 ----------

async function handleNovelRoute(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    // 書源選擇：只接受 SOURCES 裡有的名稱（轉小寫），不合法就用預設書源。
    const sourceKey = SOURCES[(query.source || '').toLowerCase()] ? query.source.toLowerCase() : DEFAULT_SOURCE;
    const src = SOURCES[sourceKey];
    const novelId = String(query.novelId || '');
    const chapterId = String(query.chapterId || '');

    // 所有書源操作都在 try 裡，下面 catch 依錯誤類型決定回 502 或 500。
    try {
        if (pathname === '/api/novel/search') {
            // 搜尋字串去空白並限制 50 字，避免超長輸入。
            const q = String(query.q || '').trim().slice(0, 50);
            if (!q) {
                return sendJson(res, 400, { success: false, source: sourceKey, error: '請輸入小說名稱或作者' });
            }
            const results = (await src.search(q)).map(n => ({ ...n, source: sourceKey, sourceName: src.name }));
            return sendJson(res, 200, { success: true, source: sourceKey, sourceName: src.name, count: results.length, results });
        }

        if (pathname === '/api/novel/chapters') {
            // 先驗證編號格式再去抓，避免使用者把任意字串拼進對外請求的網址。
            if (!src.validNovelId(novelId)) return sendJson(res, 400, { success: false, error: '作品編號格式錯誤' });
            const chapters = await src.chapters(novelId);
            return sendJson(res, 200, { success: true, source: sourceKey, novelId, chapters, count: chapters.length });
        }

        if (pathname === '/api/novel/content') {
            if (!src.validNovelId(novelId) || !/^\d{1,20}$/.test(chapterId)) {
                return sendJson(res, 400, { success: false, error: '章節編號格式錯誤' });
            }
            const { title, paragraphs } = await src.content(novelId, chapterId);
            if (!paragraphs.length) {
                return sendJson(res, 502, { success: false, unavailable: true, error: `${src.name}未回傳此章節正文` });
            }
            return sendJson(res, 200, { success: true, source: sourceKey, novelId, chapterId, title, paragraphs });
        }

        return sendJson(res, 404, { success: false, error: '找不到該 API 端點' });
    // 錯誤處理：SourceError 是書源端的問題 -> 502 並顯示「暫時無法連線」；其他未預期錯誤 -> 記 log 並回 500。
    } catch (err) {
        if (err instanceof SourceError) {
            console.warn(`[Novel API] ${src.name}: ${err.message}`);
            return sendJson(res, 502, { success: false, unavailable: true, source: sourceKey, error: `${src.name}暫時無法連線：${err.message}` });
        }
        console.error('[Novel API Error]:', err);
        return sendJson(res, 500, { success: false, source: sourceKey, error: '小說服務內部錯誤' });
    }
}

// 匯出給 server.js 的 API_ROUTES 使用。
module.exports = { handleNovelRoute };
