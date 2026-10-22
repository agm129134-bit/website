/**
 * Web Library - Kazumi 動漫後端核心模組
 * 採用 Node.js 原生環境 (CommonJS, global fetch, stream, url)
 * 零依賴、免裝 npm 套件！支援載入 KazumiRules 外部規則爬蟲！
 */
const { Readable } = require('node:stream');
const fs = require('fs');
const path = require('path');

// 統一設置 CORS 與 JSON 回應
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

// 原生 fetch 封裝（自帶超時防護與 AbortController）
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return response;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

// 取得 URL 查詢參數安全輔助函數
function getQueryParam(parsedUrl, key) {
    return (parsedUrl.searchParams && parsedUrl.searchParams.get(key)) ? parsedUrl.searchParams.get(key).trim() : '';
}

// 常用簡繁動漫字詞對映與片名純化 (提升爬蟲檢索命中率)
const S2T_MAP = {
    '蓮': '莲', '黨': '党', '迴': '回', '戰': '战', '極': '极', '樂': '乐', '湯': '汤',
    '搖': '摇', '曳': '曳', '露': '露', '營': '营', '無': '无', '職': '职', '轉': '转',
    '生': '生', '戀': '恋', '愛': '爱', '貓': '猫', '偵': '侦', '探': '探', '麗': '丽',
    '偽': '伪', '術': '术', '師': '师', '進': '进', '擊': '击', '巨': '巨', '人': '人',
    '間': '间', '諜': '谍', '家': '家', '酒': '酒', '銀': '银', '魂': '魂', '機': '机',
    '動': '动', '鋼': '钢', '彈': '弹', '鬼': '鬼', '滅': '灭', '之': '之', '刃': '刃',
    '藍': '蓝', '鎖': '锁', '排': '排', '球': '球', '膽': '胆', '葬': '葬', '送': '送',
    '藥': '药', '獨': '独', '異': '异', '國': '国', '傳': '传', '說': '说', '險': '险'
};

function normalizeAnimeQuery(str) {
    if (!str) return '';
    const cleaned = str.replace(/^(【[^】]+】|\[[^\]]+\]|\([^\)]+\))\s*/g, '').replace(/第\s*\d+\s*[話集].*$/g, '').trim();
    return cleaned.split('').map(c => S2T_MAP[c] || c).join('');
}

// ==========================================
// KazumiRules 爬蟲引擎 (AGE動漫 & 7sefun)
// ==========================================

// 1. AGE動漫搜尋
async function crawlAgeSearch(keyword) {
    const searchTerms = [keyword];
    const norm = normalizeAnimeQuery(keyword);
    if (norm && norm !== keyword) searchTerms.push(norm);

    for (const term of searchTerms) {
        try {
            const url = `https://www.agedm.io/search?query=${encodeURIComponent(term)}`;
            const res = await fetchWithTimeout(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
            });
            if (!res.ok) continue;
            const html = await res.text();

            const regex = /<h5[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h5>/gi;
            const coverRegex = /<img[^>]+class="[^"]*video_thumbs[^"]*"[^>]+src="([^"]+)"/gi;
            const results = [];
            let m;
            while ((m = regex.exec(html)) !== null) {
                const link = m[1].startsWith('http') ? m[1] : `https://www.agedm.io${m[1]}`;
                const title = m[2].replace(/<[^>]+>/g, '').trim();
                results.push({
                    title: title,
                    detailUrl: link,
                    source: 'AGE'
                });
            }

            let cMatch;
            let idx = 0;
            while ((cMatch = coverRegex.exec(html)) !== null && idx < results.length) {
                results[idx].cover = cMatch[1];
                idx++;
            }

            if (results.length > 0) return results;
        } catch (e) {
            console.error('AGE search failed for:', term, e.message);
        }
    }
    return [];
}

// 2. AGE動漫選集解析（依線路分組並去重，防止多線路重疊導致集數重複）
async function crawlAgeEpisodes(detailUrl) {
    const res = await fetchWithTimeout(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error('無法讀取劇集頁面');
    const html = await res.text();

    const playRegex = /<a[^>]+href="(\/play\/(\d+)\/(\d+)\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const linesMap = new Map();
    while ((m = playRegex.exec(html)) !== null) {
        const fullPath = m[1];
        const lineId = m[3] || '1';
        const epIndex = m[4];
        const title = m[5].replace(/<[^>]+>/g, '').trim();
        const playUrl = fullPath.startsWith('http') ? fullPath : `https://www.agedm.io${fullPath}`;

        if (!linesMap.has(lineId)) linesMap.set(lineId, []);
        const lineList = linesMap.get(lineId);
        if (!lineList.some(e => e.title === title || e.epIndex === epIndex)) {
            lineList.push({ title, playUrl, line: lineId, epIndex });
        }
    }

    if (linesMap.size > 0) {
        let chosenLine = linesMap.get('1');
        if (!chosenLine || chosenLine.length === 0) {
            let maxCount = 0;
            for (const [, list] of linesMap.entries()) {
                if (list.length > maxCount) {
                    maxCount = list.length;
                    chosenLine = list;
                }
            }
        }
        return chosenLine || [];
    }

    // 寬鬆降級方案
    const looseRegex = /<a[^>]+href="(\/play\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    const seenTitles = new Set();
    const episodes = [];
    while ((lm = looseRegex.exec(html)) !== null) {
        const title = lm[2].replace(/<[^>]+>/g, '').trim();
        const playUrl = lm[1].startsWith('http') ? lm[1] : `https://www.agedm.io${lm[1]}`;
        if (!seenTitles.has(title)) {
            seenTitles.add(title);
            episodes.push({ title, playUrl });
        }
    }
    return episodes;
}

// 3. AGE動漫播放器真實網址解析
async function crawlAgePlayer(playUrl) {
    const res = await fetchWithTimeout(playUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error('無法讀取播放器頁面');
    const html = await res.text();
    const iframeMatch = html.match(/<iframe[^>]+id="iframeForVideo"[^>]+src="([^"]+)"/i) 
                     || html.match(/<iframe[^>]+src="([^"]+)"/i);
    return iframeMatch ? iframeMatch[1] : null;
}

// 4. 7sefun動漫搜尋 (備用源)
async function crawl7sefunSearch(keyword) {
    const searchTerms = [keyword];
    const norm = normalizeAnimeQuery(keyword);
    if (norm && norm !== keyword) searchTerms.push(norm);

    for (const term of searchTerms) {
        try {
            const url = `https://www.7sefun.top/vodsearch/-------------.html?wd=${encodeURIComponent(term)}`;
            const res = await fetchWithTimeout(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36' }
            });
            if (!res.ok) continue;
            const html = await res.text();
            const regex = /<a[^>]+class="video-wrapper"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]+alt="([^"]+)"/gi;
            const results = [];
            let m;
            while ((m = regex.exec(html)) !== null) {
                const link = m[1].startsWith('http') ? m[1] : `https://www.7sefun.top${m[1]}`;
                results.push({
                    title: m[3].trim(),
                    cover: m[2],
                    detailUrl: link,
                    source: '7sefun'
                });
            }
            if (results.length > 0) return results;
        } catch (e) {
            console.error('7sefun search failed for:', term, e.message);
        }
    }
    return [];
}

// 5. 7sefun選集解析（依播放線路分組並去重）
async function crawl7sefunEpisodes(detailUrl) {
    const res = await fetchWithTimeout(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error('無法讀取 7sefun 劇集頁面');
    const html = await res.text();

    const regex = /<a[^>]+href="(\/vodplay\/(\d+)-(\d+)-(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const linesMap = new Map();
    while ((m = regex.exec(html)) !== null) {
        const fullPath = m[1];
        const lineId = m[3] || '1';
        const epIndex = m[4];
        const title = m[5].replace(/<[^>]+>/g, '').trim();
        const link = `https://www.7sefun.top${fullPath}`;

        if (!linesMap.has(lineId)) linesMap.set(lineId, []);
        const lineList = linesMap.get(lineId);
        if (!lineList.some(e => e.title === title || e.epIndex === epIndex)) {
            lineList.push({ title, playUrl: link, line: lineId, epIndex });
        }
    }

    if (linesMap.size > 0) {
        let chosen = linesMap.get('1');
        if (!chosen || chosen.length === 0) {
            let maxCount = 0;
            for (const [, list] of linesMap.entries()) {
                if (list.length > maxCount) {
                    maxCount = list.length;
                    chosen = list;
                }
            }
        }
        return chosen || [];
    }

    // 寬鬆降級方案
    const looseRegex = /<a[^>]+href="(\/vodplay\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    const seen = new Set();
    const episodes = [];
    while ((lm = looseRegex.exec(html)) !== null) {
        const link = lm[1].startsWith('http') ? lm[1] : `https://www.7sefun.top${lm[1]}`;
        const title = lm[2].replace(/<[^>]+>/g, '').trim();
        if (!seen.has(title)) {
            seen.add(title);
            episodes.push({ title, playUrl: link });
        }
    }
    return episodes;
}

/**
 * 處理 Kazumi API 路由主入口
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 */
async function handleKazumiRoute(req, res) {
    try {
        const host = req.headers.host || '127.0.0.1';
        const parsedUrl = new URL(req.url, `http://${host}`);
        const pathname = parsedUrl.pathname;

        // 1. CORS OPTIONS 預檢請求
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
            res.statusCode = 204;
            res.end();
            return;
        }

        // 2. 路由 A: Bangumi 官方動漫搜尋 /api/kazumi/search?q={關鍵字}
        if (pathname === '/api/kazumi/search') {
            const q = getQueryParam(parsedUrl, 'q');
            if (!q) {
                return sendJson(res, 400, { success: false, error: '請提供搜尋關鍵字參數 "q"' });
            }

            try {
                const bangumiUrl = `https://api.bgm.tv/search/subject/${encodeURIComponent(q)}?type=2&responseGroup=medium`;
                const response = await fetchWithTimeout(bangumiUrl, {
                    headers: { 'User-Agent': 'WebLibrary-Kazumi/1.0.0 (Windows NT 10.0; Win64; x64)' }
                });

                if (!response.ok) {
                    return sendJson(res, 502, { success: false, error: '無法連線至 Bangumi 資料庫 API' });
                }

                const data = await response.json();
                const list = Array.isArray(data.list) ? data.list : [];
                
                const results = list.map(item => ({
                    id: item.id,
                    title: item.name || '',
                    title_cn: item.name_cn || item.name || '',
                    cover: (item.images && (item.images.common || item.images.medium || item.images.large)) || '',
                    rating: (item.rating && item.rating.score) ? Number(item.rating.score.toFixed(1)) : 0,
                    eps: item.eps || 0,
                    summary: item.summary || '暫無簡介。'
                }));

                return sendJson(res, 200, {
                    success: true,
                    count: results.length,
                    results: results
                });
            } catch (err) {
                console.error('[Kazumi Search Error]:', err.message);
                return sendJson(res, 500, { success: false, error: '搜尋動漫失敗：' + err.message });
            }
        }

        // 3. 路由 B: 影片/動漫來源解析 /api/kazumi/resolve?bvid={bvid}&url={url}
        else if (pathname === '/api/kazumi/resolve') {
            const bvid = getQueryParam(parsedUrl, 'bvid');
            const url = getQueryParam(parsedUrl, 'url');

            // 判斷是否為 Bilibili BV 號
            let bvMatch = null;
            if (url) {
                bvMatch = url.match(/BV[a-zA-Z0-9]{10}/i);
            } else if (bvid) {
                bvMatch = bvid.match(/BV[a-zA-Z0-9]{10}/i) || [bvid];
            }

            if (bvMatch) {
                const targetBvid = bvMatch[0];
                try {
                    const pageListUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${targetBvid}`;
                    const pageRes = await fetchWithTimeout(pageListUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://www.bilibili.com/'
                        }
                    });

                    let episodes = [];
                    if (pageRes.ok) {
                        const pageJson = await pageRes.json();
                        if (pageJson.code === 0 && Array.isArray(pageJson.data)) {
                            episodes = pageJson.data.map(p => ({
                                page: p.page,
                                cid: p.cid,
                                part: p.part || `第 ${p.page} 話`,
                                duration: p.duration
                            }));
                        }
                    }

                    let title = `Bilibili 影片 (${targetBvid})`;
                    let cover = '';
                    let owner = 'Bilibili 創作者';
                    let desc = '點擊播放即可透過 Kazumi 劇院無廣告觀賞';

                    try {
                        const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${targetBvid}`;
                        const viewRes = await fetchWithTimeout(viewUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/'
                            }
                        }, 5000);

                        if (viewRes.ok) {
                            const viewJson = await viewRes.json();
                            if (viewJson.code === 0 && viewJson.data) {
                                title = viewJson.data.title || title;
                                cover = viewJson.data.pic || cover;
                                owner = (viewJson.data.owner && viewJson.data.owner.name) || owner;
                                desc = viewJson.data.desc || desc;
                            }
                        }
                    } catch (e) {}

                    if (episodes.length === 0) {
                        episodes = [{ page: 1, cid: 0, part: title, duration: 0 }];
                    }

                    return sendJson(res, 200, {
                        success: true,
                        data: {
                            type: 'bilibili',
                            bvid: targetBvid,
                            title: title,
                            cover: cover,
                            owner: owner,
                            desc: desc,
                            episodes: episodes
                        }
                    });
                } catch (err) {
                    console.error('[Kazumi Resolve Error]:', err.message);
                    return sendJson(res, 500, { success: false, error: '解析 Bilibili 影片失敗：' + err.message });
                }
            }
            else if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
                return sendJson(res, 200, {
                    success: true,
                    data: {
                        type: 'stream',
                        title: '外部動漫串流',
                        cover: '',
                        owner: '網路串流',
                        desc: '外部網路直連串流資源',
                        episodes: [{
                            page: 1,
                            cid: 0,
                            part: '第 01 話 (完整播放)',
                            url: url,
                            proxyUrl: `/api/kazumi/stream-proxy?url=${encodeURIComponent(url)}`
                        }]
                    }
                });
            }

            return sendJson(res, 400, { success: false, error: '請提供有效的 "url" 或 "bvid" 參數' });
        }

        // 4. 路由 C: 彈幕數據 /api/kazumi/danmaku?cid={cid} (無預設假彈幕)
        else if (pathname === '/api/kazumi/danmaku') {
            const cid = getQueryParam(parsedUrl, 'cid');

            if (cid && /^\d+$/.test(cid)) {
                try {
                    const dmUrl = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
                    const response = await fetchWithTimeout(dmUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://www.bilibili.com/'
                        }
                    }, 8000);

                    if (response.ok) {
                        const xmlText = await response.text();
                        const dmRegex = /<d p="([^"]+)">([^<]+)<\/d>/g;
                        const list = [];
                        let m;
                        while ((m = dmRegex.exec(xmlText)) !== null) {
                            const pParts = m[1].split(',');
                            list.push({
                                time: Math.floor(parseFloat(pParts[0]) || 0),
                                color: '#' + (parseInt(pParts[3], 10) || 16777215).toString(16).padStart(6, '0'),
                                content: m[2]
                            });
                            if (list.length >= 80) break;
                        }

                        if (list.length > 0) {
                            return sendJson(res, 200, {
                                success: true,
                                source: 'bilibili_live',
                                count: list.length,
                                danmaku: list
                            });
                        }
                    }
                } catch (err) {
                    console.log('[Kazumi Danmaku] B站即時彈幕取得略過:', err.message);
                }
            }

            // 無 cid 或取得失敗，回傳乾淨空清單（無預設假彈幕）
            return sendJson(res, 200, {
                success: true,
                source: 'none',
                count: 0,
                danmaku: []
            });
        }

        // 5. 路由 D: 串流與防盜鏈代理 /api/kazumi/stream-proxy?url={encodedUrl}
        else if (pathname === '/api/kazumi/stream-proxy') {
            const rawUrl = getQueryParam(parsedUrl, 'url');
            if (!rawUrl) {
                return sendJson(res, 400, { success: false, error: '缺少目標串流網址參數 "url"' });
            }

            let targetUrl = decodeURIComponent(rawUrl);
            let parsedTarget;
            try {
                parsedTarget = new URL(targetUrl);
            } catch (e) {
                return sendJson(res, 400, { success: false, error: '目標網址格式無效' });
            }

            if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
                return sendJson(res, 400, { success: false, error: '僅支援 HTTP / HTTPS 串流協定' });
            }

            const proxyHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': '*/*'
            };

            if (req.headers.range) {
                proxyHeaders['Range'] = req.headers.range;
            }

            if (parsedTarget.hostname.includes('bilibili') || parsedTarget.hostname.includes('hdslb')) {
                proxyHeaders['Referer'] = 'https://www.bilibili.com/';
            }

            const controller = new AbortController();
            req.on('close', () => controller.abort());

            try {
                const proxyRes = await fetch(targetUrl, {
                    method: 'GET',
                    headers: proxyHeaders,
                    signal: controller.signal
                });

                res.statusCode = proxyRes.status;
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Headers', 'Range');
                res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

                const headersToPass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
                for (const h of headersToPass) {
                    const val = proxyRes.headers.get(h);
                    if (val) res.setHeader(h, val);
                }

                if (!proxyRes.body) {
                    return res.end();
                }

                const nodeStream = Readable.fromWeb(proxyRes.body);
                nodeStream.pipe(res);
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error('[Kazumi Stream Proxy Error]:', err.message);
                if (!res.headersSent) {
                    sendJson(res, 502, { success: false, error: '串流代理傳輸失敗：' + err.message });
                }
            }
        }

        // 6. 路由 E: 取得已支援的 KazumiRules 清單 /api/kazumi/rules
        else if (pathname === '/api/kazumi/rules') {
            return sendJson(res, 200, {
                success: true,
                rules: [
                    { id: 'AGE', name: 'AGE動漫 (全網動漫資源庫 · 資源最多)', baseURL: 'https://www.agedm.io/', version: '1.5' },
                    { id: '7sefun', name: '7sefun動漫 (備用源)', baseURL: 'https://www.7sefun.top/', version: '1.3' }
                ]
            });
        }

        // 7. 路由 F: KazumiRules 外部動漫搜尋 /api/kazumi/rule-search?q={keyword}&source={source}
        else if (pathname === '/api/kazumi/rule-search') {
            const q = getQueryParam(parsedUrl, 'q');
            const source = getQueryParam(parsedUrl, 'source') || 'AGE';
            if (!q) {
                return sendJson(res, 400, { success: false, error: '請提供搜尋關鍵字 "q"' });
            }

            try {
                let results = [];
                if (source === '7sefun') {
                    results = await crawl7sefunSearch(q);
                } else {
                    results = await crawlAgeSearch(q);
                }

                return sendJson(res, 200, {
                    success: true,
                    source: source,
                    count: results.length,
                    results: results
                });
            } catch (err) {
                console.error('[Kazumi Rule Search Error]:', err.message);
                return sendJson(res, 500, { success: false, error: '規則搜尋失敗：' + err.message });
            }
        }

        // 8. 路由 G: 取得指定動漫的全部選集 /api/kazumi/rule-episodes?detailUrl={detailUrl}
        else if (pathname === '/api/kazumi/rule-episodes') {
            const detailUrl = getQueryParam(parsedUrl, 'detailUrl');
            if (!detailUrl) {
                return sendJson(res, 400, { success: false, error: '缺少 detailUrl 參數' });
            }

            try {
                let episodes = [];
                if (detailUrl.includes('7sefun')) {
                    episodes = await crawl7sefunEpisodes(detailUrl);
                } else {
                    episodes = await crawlAgeEpisodes(detailUrl);
                }
                return sendJson(res, 200, {
                    success: true,
                    count: episodes.length,
                    episodes: episodes
                });
            } catch (err) {
                console.error('[Kazumi Rule Episodes Error]:', err.message);
                return sendJson(res, 500, { success: false, error: '取得選集失敗：' + err.message });
            }
        }

        // 9. 路由 H: 解析單集播放器網址 /api/kazumi/rule-play?playUrl={playUrl}
        else if (pathname === '/api/kazumi/rule-play') {
            const playUrl = getQueryParam(parsedUrl, 'playUrl');
            if (!playUrl) {
                return sendJson(res, 400, { success: false, error: '缺少 playUrl 參數' });
            }

            try {
                let playerUrl = null;
                if (playUrl.includes('7sefun')) {
                    playerUrl = playUrl;
                } else {
                    playerUrl = await crawlAgePlayer(playUrl);
                }

                if (!playerUrl) {
                    return sendJson(res, 404, { success: false, error: '未找到播放器網址' });
                }
                return sendJson(res, 200, {
                    success: true,
                    playerUrl: playerUrl
                });
            } catch (err) {
                console.error('[Kazumi Rule Play Error]:', err.message);
                return sendJson(res, 500, { success: false, error: '解析播放器失敗：' + err.message });
            }
        }

        // 10. 未知 Kazumi 路由
        else {
            sendJson(res, 404, { success: false, error: '找不到該 Kazumi API 路由: ' + pathname });
        }
    } catch (globalErr) {
        console.error('[Kazumi Global Error]:', globalErr);
        sendJson(res, 500, { success: false, error: '伺服器內部發生異常：' + globalErr.message });
    }
}

module.exports = { handleKazumiRoute };
