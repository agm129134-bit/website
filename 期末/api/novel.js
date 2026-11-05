/**
 * Web Library - 小說線上書源後端 (/api/novel)
 *
 * 舊版只讀 data/novels_wenku8.json 與 data/novels_bilinovel.json，兩檔皆為空陣列，
 * 且 Wenku8 搜尋需登入、Bilinovel(linovelib) 搜尋被擋，因此改為即時爬取兩個免登入書源：
 *   - piaotia : 飄天文學 www.piaotia.com (GBK 編碼，搜尋需以 GBK 送出關鍵字)
 *   - ixdzs   : 愛下電子書 ixdzs8.com   (UTF-8，章節目錄走 JSON API)
 *
 * 端點：
 *   GET /api/novel/search?q=&source=
 *   GET /api/novel/chapters?novelId=&source=
 *   GET /api/novel/content?novelId=&chapterId=&source=
 * 失敗時回傳 { success:false, unavailable:true, error } 讓前端顯示「書源暫時無法連線」。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 10000;
const DEFAULT_SOURCE = 'piaotia';

// ---------- 共用工具 ----------

function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

class SourceError extends Error {}

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

const stripTags = s => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).trim();

// HTML 片段 → 段落陣列
function toParagraphs(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .split(/<br\s*\/?>|<\/p>/i)
        .map(stripTags)
        .map(s => s.replace(/^[\s　]+|[\s　]+$/g, ''))
        .filter(Boolean);
}

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

// GBK 編碼表：以內建 TextDecoder('gbk') 反推，免安裝 iconv 套件
let gbkMap = null;
function encodeGbkURIComponent(str) {
    if (!gbkMap) {
        gbkMap = new Map();
        const dec = new TextDecoder('gbk');
        for (let a = 0x81; a <= 0xfe; a++) {
            for (let b = 0x40; b <= 0xfe; b++) {
                if (b === 0x7f) continue;
                const ch = dec.decode(Uint8Array.of(a, b));
                if (ch.length === 1 && ch !== '�' && !gbkMap.has(ch)) gbkMap.set(ch, [a, b]);
            }
        }
    }
    let out = '';
    for (const ch of str) {
        if (ch.charCodeAt(0) < 0x80) { out += encodeURIComponent(ch); continue; }
        const bytes = gbkMap.get(ch);
        if (bytes) out += bytes.map(x => '%' + x.toString(16).toUpperCase()).join('');
        // 無法以 GBK 表示的字元 (如 emoji) 直接略過
    }
    return out;
}

// ---------- 書源：飄天文學 piaotia (GBK) ----------
// novelId 形如 "9/9459"，chapterId 為純數字

const PIAOTIA = 'https://www.piaotia.com';
const piaotia = {
    name: '飄天文學',
    validNovelId: id => /^\d{1,4}\/\d{1,8}$/.test(id),

    cover(id) {
        const [, bid] = id.split('/');
        return `${PIAOTIA}/files/article/image/${id}/${bid}s.jpg`;
    },

    async search(q) {
        const kw = encodeGbkURIComponent(q);
        if (!kw) return [];
        const { url, text } = await fetchRemote(`${PIAOTIA}/modules/article/search.php`, {
            method: 'POST',
            encoding: 'gbk',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: PIAOTIA + '/' },
            body: `searchtype=articlename&searchkey=${kw}&action=login&submit=`
        });

        // 完全吻合時網站會直接 302 到書籍資訊頁
        const direct = url.match(/\/bookinfo\/(\d+\/\d+)\.html/);
        if (direct) {
            const id = direct[1];
            const title = stripTags((text.match(/<h1>([\s\S]*?)<\/h1>/i) || [])[1]) || q;
            const author = stripTags((text.match(/作\s*(?:&nbsp;)*\s*者：([^<]+)/) || [])[1]);
            const category = stripTags((text.match(/类(?:&nbsp;|\s)*别：([^<]+)/) || [])[1]);
            const introHtml = (text.match(/内容简介：<\/span>([\s\S]*?)<\/td>/) || [])[1];
            return [{
                id, title, author, category,
                status: /连载/.test(text.match(/文章状态：([^<]+)/)?.[1] || '') ? '連載' : '完結',
                cover: this.cover(id),
                intro: toParagraphs(introHtml).join(' ')
            }];
        }

        const results = [];
        const rowRe = /<tr>\s*<td class="odd"><a href="[^"]*\/bookinfo\/(\d+\/\d+)\.html">([^<]+)<\/a><\/td>\s*<td class="even">[\s\S]*?<\/td>\s*<td class="odd">([^<]*)<\/td>\s*<td class="even">[^<]*<\/td>\s*<td class="odd"[^>]*>[^<]*<\/td>\s*<td class="even"[^>]*>([^<]*)<\/td>/g;
        let m;
        while ((m = rowRe.exec(text)) && results.length < 30) {
            results.push({
                id: m[1],
                title: stripTags(m[2]),
                author: stripTags(m[3]),
                category: '',
                status: m[4].includes('连载') ? '連載' : '完結',
                cover: this.cover(m[1]),
                intro: ''
            });
        }
        return results;
    },

    async chapters(id) {
        return cached(`piaotia:${id}`, async () => {
            const { text } = await fetchRemote(`${PIAOTIA}/html/${id}/index.html`, { encoding: 'gbk' });
            const chapters = [];
            const re = /<li><a href="(\d+)\.html">([^<]+)<\/a><\/li>/g;
            let m;
            while ((m = re.exec(text))) chapters.push({ id: m[1], title: stripTags(m[2]) });
            return chapters;
        });
    },

    async content(id, chapterId) {
        const { text } = await fetchRemote(`${PIAOTIA}/html/${id}/${chapterId}.html`, { encoding: 'gbk' });
        const h1 = (text.match(/<h1>([\s\S]*?)<\/h1>/i) || [])[1] || '';
        // 標題去掉前面的書名連結
        const title = stripTags(h1.replace(/<a[\s\S]*?<\/a>/i, ''));
        const endIdx = text.indexOf('<!-- 翻页上AD开始 -->');
        let body = endIdx > 0 ? text.slice(0, endIdx) : text;
        body = body.slice(body.lastIndexOf('</table>') + '</table>'.length);
        body = body.replace(/<\/div>\s*$/, '');
        return { title, paragraphs: toParagraphs(body) };
    }
};

// ---------- 書源：愛下電子書 ixdzs (UTF-8) ----------
// novelId 為純數字 bid，chapterId 為 ordernum

const IXDZS = 'https://ixdzs8.com';
const ixdzs = {
    name: '愛下電子書',
    validNovelId: id => /^\d{1,9}$/.test(id),

    async search(q) {
        const { text } = await fetchRemote(`${IXDZS}/bsearch?q=${encodeURIComponent(q)}`);
        const results = [];
        const items = text.split('<li class="burl"').slice(1);
        for (const item of items) {
            const id = (item.match(/data-url="\/read\/(\d+)\/"/) || [])[1];
            if (!id) continue;
            results.push({
                id,
                title: stripTags((item.match(/<h3 class="bname"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1]),
                author: stripTags((item.match(/class="bauthor"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1]),
                category: '',
                status: /连载/.test(item.match(/class="lz">([^<]*)/)?.[1] || '') ? '連載' : '完結',
                cover: (item.match(/<img src="([^"]+)"/) || [])[1] || '',
                intro: stripTags((item.match(/class="l-p2">([\s\S]*?)<\/p>/) || [])[1])
            });
            if (results.length >= 30) break;
        }
        return results;
    },

    async chapters(id) {
        return cached(`ixdzs:${id}`, async () => {
            const { text } = await fetchRemote(`${IXDZS}/novel/clist/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer: `${IXDZS}/read/${id}/`
                },
                body: `bid=${id}`
            });
            let json;
            try { json = JSON.parse(text); } catch { throw new SourceError('章節目錄格式異常'); }
            const list = Array.isArray(json && json.data) ? json.data : [];
            const chapters = [];
            let volumeTitle = '';
            for (const c of list) {
                if (String(c.ctype) !== '0') { volumeTitle = stripTags(c.title); continue; } // 分卷標題
                if (!/^\d+$/.test(String(c.ordernum))) continue;
                chapters.push({ id: String(c.ordernum), title: stripTags(c.title), volumeTitle });
            }
            return chapters;
        });
    },

    async content(id, chapterId) {
        const { text } = await fetchRemote(`${IXDZS}/read/${id}/p${chapterId}.html`);
        const article = (text.match(/<article class="page-content">([\s\S]*?)<\/article>/) || [])[1] || '';
        const title = stripTags((article.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1]);
        const section = (article.match(/<section>([\s\S]*?)<\/section>/) || [])[1] || '';
        return { title, paragraphs: toParagraphs(section) };
    }
};

const SOURCES = { piaotia, ixdzs };

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

    const sourceKey = SOURCES[(query.source || '').toLowerCase()] ? query.source.toLowerCase() : DEFAULT_SOURCE;
    const src = SOURCES[sourceKey];
    const novelId = String(query.novelId || '');
    const chapterId = String(query.chapterId || '');

    try {
        if (pathname === '/api/novel/search') {
            const q = String(query.q || '').trim().slice(0, 50);
            if (!q) {
                return sendJson(res, 400, { success: false, source: sourceKey, error: '請輸入小說名稱或作者' });
            }
            const results = (await src.search(q)).map(n => ({ ...n, source: sourceKey, sourceName: src.name }));
            return sendJson(res, 200, { success: true, source: sourceKey, sourceName: src.name, count: results.length, results });
        }

        if (pathname === '/api/novel/chapters') {
            if (!src.validNovelId(novelId)) return sendJson(res, 400, { success: false, error: '作品編號格式錯誤' });
            const chapters = await src.chapters(novelId);
            return sendJson(res, 200, { success: true, source: sourceKey, novelId, chapters, count: chapters.length });
        }

        if (pathname === '/api/novel/content') {
            if (!src.validNovelId(novelId) || !/^\d{1,10}$/.test(chapterId)) {
                return sendJson(res, 400, { success: false, error: '章節編號格式錯誤' });
            }
            const { title, paragraphs } = await src.content(novelId, chapterId);
            if (!paragraphs.length) {
                return sendJson(res, 502, { success: false, unavailable: true, error: `${src.name}未回傳此章節正文` });
            }
            return sendJson(res, 200, { success: true, source: sourceKey, novelId, chapterId, title, paragraphs });
        }

        return sendJson(res, 404, { success: false, error: '找不到該 API 端點' });
    } catch (err) {
        if (err instanceof SourceError) {
            console.warn(`[Novel API] ${src.name}: ${err.message}`);
            return sendJson(res, 502, { success: false, unavailable: true, source: sourceKey, error: `${src.name}暫時無法連線：${err.message}` });
        }
        console.error('[Novel API Error]:', err);
        return sendJson(res, 500, { success: false, source: sourceKey, error: '小說服務內部錯誤' });
    }
}

module.exports = { handleNovelRoute };
