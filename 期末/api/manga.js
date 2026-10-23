/**
 * Tachimanga 條漫閱讀器後端模組 (CopyManga / 全網漫畫規則引擎)
 * 採用 Node.js 原生 https / http 模組，零相依、高效率
 */
const https = require('https');
const http = require('http');
const url = require('url');

const COPYMANGA_HOSTS = ['api.mangacopy.com', 'api.copy-manga.com'];

function httpGetJson(targetUrl, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'version': '2.1.8',
                'platform': '1',
                ...headers
            },
            timeout: 10000
        };

        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpGetJson(res.headers.location, headers));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    reject(new Error(`JSON 解析失敗: ${e.message} (Status: ${res.statusCode})`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('請求超時 (10s)'));
        });
        req.end();
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

// 代理圖片傳輸 (繞過防盜鏈或證書問題)
function proxyImage(imgUrl, res) {
    if (!imgUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('請提供 imgUrl');
    }

    try {
        const parsed = new URL(imgUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request(parsed, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': ''
            },
            timeout: 15000
        }, (imgRes) => {
            res.writeHead(imgRes.statusCode, {
                'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
            });
            imgRes.pipe(res);
        });

        req.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('代理圖片失敗: ' + err.message);
        });
        req.end();
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('無效的圖片網址: ' + e.message);
    }
}

// 漫畫搜尋核心 (支援 CopyManga + MangaDex 雙來源聚合)
async function searchCopyManga(keyword) {
    let lastError = null;
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/search/comic?format=json&platform=1&limit=24&q=${encodeURIComponent(keyword)}`;
            const res = await httpGetJson(apiUrl);
            if (res && res.results && Array.isArray(res.results.list)) {
                return res.results.list.map(item => ({
                    id: item.path_word,
                    title: item.name,
                    alias: item.alias || '',
                    author: Array.isArray(item.author) ? item.author.map(a => a.name).join(', ') : '',
                    cover: item.cover || '',
                    brief: item.brief || '',
                    popular: item.popular || 0,
                    source: 'CopyManga'
                }));
            }
        } catch (e) {
            lastError = e;
        }
    }
    return [];
}

// 漫畫搜尋核心 (專注於 CopyManga 全網高清穩定漫畫庫)
async function searchManga(keyword) {
    const list = await searchCopyManga(keyword);
    if (!list || list.length === 0) {
        throw new Error('查無符合之漫畫作品，請更換關鍵字後重試');
    }
    return list;
}

// 取得話數章節列表
async function getMangaChapters(mangaId) {
    let lastError = null;
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/comic/${encodeURIComponent(mangaId)}/group/default/chapters?limit=500&offset=0`;
            const res = await httpGetJson(apiUrl);
            if (res && res.results && Array.isArray(res.results.list)) {
                return res.results.list.map(ch => ({
                    id: ch.uuid,
                    title: ch.name,
                    index: ch.index,
                    size: ch.size || 0
                }));
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('取得章節清單失敗');
}

// 取得單話圖片列表
async function getChapterPages(mangaId, chapterId) {
    let lastError = null;
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/comic/${encodeURIComponent(mangaId)}/chapter/${encodeURIComponent(chapterId)}?platform=1`;
            const res = await httpGetJson(apiUrl);
            if (res && res.results && res.results.chapter && Array.isArray(res.results.chapter.contents)) {
                return res.results.chapter.contents.map(p => p.url);
            }
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('取得章節圖片失敗');
}

// 主路由處理器
async function handleMangaRoute(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    try {
        // 1. 搜尋漫畫: /api/manga/search?q=關鍵字
        if (pathname === '/api/manga/search') {
            const q = (query.q || '').trim();
            if (!q) {
                return sendJson(res, 400, { success: false, error: '請提供搜尋關鍵字 "q"' });
            }
            const results = await searchManga(q);
            return sendJson(res, 200, {
                success: true,
                count: results.length,
                results: results
            });
        }

        // 2. 取得漫畫話數章節: /api/manga/chapters?mangaId=xxx
        else if (pathname === '/api/manga/chapters') {
            const mangaId = (query.mangaId || '').trim();
            if (!mangaId) {
                return sendJson(res, 400, { success: false, error: '請提供漫畫 ID "mangaId"' });
            }
            const chapters = await getMangaChapters(mangaId);
            return sendJson(res, 200, {
                success: true,
                count: chapters.length,
                chapters: chapters
            });
        }

        // 3. 取得單話圖片: /api/manga/pages?mangaId=xxx&chapterId=yyy
        else if (pathname === '/api/manga/pages') {
            const mangaId = (query.mangaId || '').trim();
            const chapterId = (query.chapterId || '').trim();
            if (!mangaId || !chapterId) {
                return sendJson(res, 400, { success: false, error: '請提供 "mangaId" 與 "chapterId"' });
            }
            const pages = await getChapterPages(mangaId, chapterId);
            return sendJson(res, 200, {
                success: true,
                count: pages.length,
                pages: pages
            });
        }

        // 4. 圖片反向代理: /api/manga/proxy?url=xxx
        else if (pathname === '/api/manga/proxy') {
            const imgUrl = query.url;
            return proxyImage(imgUrl, res);
        }

        else {
            return sendJson(res, 404, { success: false, error: '找不到該漫畫 API 端點' });
        }
    } catch (err) {
        console.error('[Manga API Error]:', err.message);
        return sendJson(res, 500, { success: false, error: err.message });
    }
}

module.exports = {
    handleMangaRoute,
    searchManga,
    getMangaChapters,
    getChapterPages
};
