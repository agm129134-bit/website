/**
 * Tachimanga 條漫閱讀器後端模組 (BaoziManga / CopyManga 全網漫畫聚合引擎)
 * 採用 Node.js 原生 fetch / http 模組，零相依、高效率
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
                'User-Agent': 'Dart/3.0 (dart:io)',
                'version': '3.0.0',
                'platform': '3',
                'source': 'copyApp',
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
        let referer = '';
        if (parsed.hostname.includes('bzcdn.net') || parsed.hostname.includes('baozimh')) {
            referer = 'https://www.webmota.com/';
        } else if (parsed.hostname.includes('mangafunb') || parsed.hostname.includes('copymanga')) {
            referer = 'https://www.mangacopy.com/';
        }

        const req = client.request(parsed, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': referer
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

// 1. 包子漫畫 (Webmota) 搜尋解析器
async function searchBaoziManga(keyword) {
    try {
        const searchUrl = `https://www.webmota.com/search?q=${encodeURIComponent(keyword)}`;
        const res = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return [];
        const html = await res.text();
        const regex = /<a[^>]+href="(\/comic\/[^"]+)"[^>]+title="([^"]+)"[\s\S]*?<amp-img[^>]+src="([^"]+)"/gi;
        let m;
        const results = [];
        const seen = new Set();
        while ((m = regex.exec(html)) !== null) {
            const path = m[1];
            const title = m[2].trim();
            const cover = m[3].replace(/&amp;/g, '&');
            const id = path.replace('/comic/', '').trim();
            if (!seen.has(id)) {
                seen.add(id);
                results.push({
                    id: `baozi_${id}`,
                    title: title,
                    cover: cover,
                    author: '',
                    brief: '包子漫畫全網穩定源',
                    source: '包子漫畫'
                });
            }
        }
        return results;
    } catch (e) {
        console.warn('[BaoziManga Search Error]:', e.message);
        return [];
    }
}

// 2. 包子漫畫話數章節解析
async function getBaoziChapters(rawId) {
    const comicId = rawId.replace(/^baozi_/, '');
    const url = `https://www.webmota.com/comic/${encodeURIComponent(comicId)}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error('讀取包子漫畫詳情失敗 (HTTP ' + res.status + ')');
    const html = await res.text();
    const regex = /<a[^>]+href="(\/user\/page_direct\?[^"]+)"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    const chapters = [];
    const seen = new Set();
    let idx = 1;
    while ((m = regex.exec(html)) !== null) {
        const link = m[1].replace(/&amp;/g, '&');
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (!seen.has(link)) {
            seen.add(link);
            chapters.push({
                id: link,
                title: title || `第 ${idx} 話`,
                index: idx++
            });
        }
    }
    if (chapters.length === 0) {
        throw new Error('未在包子漫畫中檢索到任何章節');
    }
    return chapters;
}

// 3. 包子漫畫單話全頁圖片解析
async function getBaoziPages(pageDirectUrl) {
    const fullUrl = pageDirectUrl.startsWith('http') ? pageDirectUrl : `https://www.webmota.com${pageDirectUrl}`;
    const res = await fetch(fullUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error('讀取章節圖片頁面失敗: ' + res.status);
    const html = await res.text();
    const regex = /<amp-img[^>]+src="([^"]+)"/gi;
    let m;
    const pages = [];
    while ((m = regex.exec(html)) !== null) {
        pages.push(m[1].replace(/&amp;/g, '&'));
    }
    if (pages.length === 0) {
        throw new Error('未解析到任何漫畫頁面圖片');
    }
    return pages;
}

// 4. CopyManga 搜尋解析器 (備援)
async function searchCopyManga(keyword) {
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/search/comic?format=json&platform=1&limit=24&q=${encodeURIComponent(keyword)}`;
            const res = await httpGetJson(apiUrl);
            if (res && res.results && Array.isArray(res.results.list)) {
                return res.results.list.map(item => ({
                    id: `copy_${item.path_word}`,
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
            // ignore
        }
    }
    return [];
}

// 漫畫搜尋核心 (雙來源聚合：包子漫畫首選 + 拷貝漫畫備援)
async function searchManga(keyword) {
    const p1 = searchBaoziManga(keyword);
    const p2 = searchCopyManga(keyword);
    const [list1, list2] = await Promise.all([p1, p2]);
    const merged = [...list1, ...list2];
    if (merged.length === 0) {
        throw new Error(`查無「${keyword}」相符之漫畫作品，請更換關鍵字後重試`);
    }
    return merged;
}

// 取得話數章節列表 (支援包子漫畫與拷貝漫畫)
async function getMangaChapters(mangaId) {
    if (mangaId.startsWith('baozi_') || mangaId.includes('-')) {
        try {
            return await getBaoziChapters(mangaId);
        } catch (e) {
            console.warn('[Baozi chapters failed, trying copy fallback]:', e.message);
        }
    }

    const cleanId = mangaId.replace(/^copy_/, '');
    let lastError = null;
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/comic/${encodeURIComponent(cleanId)}/group/default/chapters?limit=500&offset=0&platform=3`;
            const res = await httpGetJson(apiUrl);
            if (res && res.results && Array.isArray(res.results.list) && res.results.list.length > 0) {
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

    // 若都失敗，嘗試嘗試以 cleanId 呼叫包子漫畫
    try {
        return await getBaoziChapters(cleanId);
    } catch (_) {}

    throw lastError || new Error('取得章節清單失敗，請稍後再試');
}

// 取得單話圖片列表
async function getChapterPages(mangaId, chapterId) {
    if (chapterId.includes('page_direct') || mangaId.startsWith('baozi_')) {
        return await getBaoziPages(chapterId);
    }

    const cleanId = mangaId.replace(/^copy_/, '');
    let lastError = null;
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/comic/${encodeURIComponent(cleanId)}/chapter/${encodeURIComponent(chapterId)}?platform=3`;
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
