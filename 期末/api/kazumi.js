/**
 * Web Library - Kazumi 動漫後端核心模組
 * 採用 Node.js 原生環境 (CommonJS, global fetch, stream, url)
 * 零依賴、免裝 npm 套件！支援載入 KazumiRules 外部規則爬蟲！
 */
const { Readable } = require('node:stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// 3. AGE動漫播放器真實網址解析 (支援 m3u8/mp4 原生直連萃取)
async function crawlAgePlayer(playUrl) {
    try {
        const res = await fetchWithTimeout(playUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
        });
        if (!res.ok) throw new Error('無法讀取播放器頁面');
        const html = await res.text();
        const iframeMatch = html.match(/<iframe[^>]+id="iframeForVideo"[^>]+src="([^"]+)"/i) 
                         || html.match(/<iframe[^>]+src="([^"]+)"/i);
        const url = iframeMatch ? iframeMatch[1] : null;
        if (!url) {
            throw new Error('未能在 AGE 播放頁中解析出播放器網址');
        }

        // 針對第三方防盜鏈外嵌播放器，採用無跨域障礙的外嵌安全播放，避免 CORS 阻斷導致黑屏
        const m3u8Match = url.match(/[?&]url=([^&]+\.(?:m3u8|mp4)[^&]*)/i) 
                       || url.match(/(https?%3A%2F%2F[^&]+\.(?:m3u8|mp4)[^&]*)/i);
        if (m3u8Match) {
            const direct = decodeURIComponent(m3u8Match[1]);
            return { playerUrl: direct, isDirectStream: true };
        }

        return { playerUrl: url, isDirectStream: false };
    } catch (e) {
        throw new Error(e.message || 'AGE動漫播放器解析失敗');
    }
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

// 6. 7sefun動漫播放器真實網址解析 (支援 dp.no3acg.com AES 解密、原生 .m3u8/.mp4 直出與跨線路容錯)
async function crawl7sefunPlayer(playUrl) {
    try {
        const res = await fetchWithTimeout(playUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
        });
        if (!res.ok) return { playerUrl: playUrl };
        const html = await res.text();

        // 嘗試解析 MacCMS 的 player_aaaa JSON 變數
        const aaaaMatch = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})<\/script>/);
        if (aaaaMatch) {
            try {
                const parsed = JSON.parse(aaaaMatch[1].trim());
                let realUrl = parsed.url;
                if (parsed.encrypt === 2) {
                    realUrl = decodeURIComponent(Buffer.from(parsed.url, 'base64').toString('utf-8'));
                } else if (parsed.encrypt === 1) {
                    realUrl = unescape(parsed.url);
                }

                if (realUrl) {
                    // 1. 若本身即為 .mp4 / .m3u8 原生直連串流，直接返回
                    if (/\.(mp4|m3u8)(\?.*)?$/i.test(realUrl)) {
                        return { playerUrl: realUrl, isDirectStream: true };
                    }

                    // 2. 若為 lmm 線路或包含 lmm85.com，調用 7sefun 官方適配器 dp.no3acg.com 進行 AES-128-CBC 解密
                    if (parsed.from === 'lmm' || realUrl.includes('lmm85.com')) {
                        try {
                            const dpUrl = `https://dp.no3acg.com/player/ec.php?code=qw&if=1&from=lmm&url=${realUrl}`;
                            const dpRes = await fetchWithTimeout(dpUrl, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                                    'Referer': 'https://www.7sefun.top/'
                                }
                            }, 8000);
                            if (dpRes.ok) {
                                const dpHtml = await dpRes.text();
                                const configMatch = dpHtml.match(/let\s+ConFig\s*=\s*(\{[\s\S]*?\})\s*,\s*box\s*=/);
                                if (configMatch) {
                                    const cfg = JSON.parse(configMatch[1]);
                                    if (cfg.url && cfg.config && cfg.config.uid) {
                                        const key = Buffer.from('2890' + cfg.config.uid + 'tB959C', 'utf-8');
                                        const iv = Buffer.from('2F131BE91247866E', 'utf-8');
                                        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                                        let streamUrl = decipher.update(cfg.url, 'base64', 'utf8');
                                        streamUrl += decipher.final('utf8');
                                        if (streamUrl && (streamUrl.startsWith('http://') || streamUrl.startsWith('https://'))) {
                                            return { playerUrl: streamUrl, isDirectStream: true };
                                        }
                                    }
                                }
                                // 解密未果但 dpUrl 可用，返回無跨域限制的 dp.no3acg.com 播放頁
                                return { playerUrl: dpUrl, isBlockedIframe: false };
                            }
                        } catch (dpErr) {
                            console.warn('[7sefun dp.no3acg.com decrypt error]:', dpErr.message);
                        }
                    }

                    // 3. 其他常見播放器適配器規則 (依據 7sefun playerconfig.js)
                    if (parsed.from === 'funzy' || parsed.from === 'sssfun' || parsed.from === '7sefun') {
                        return { playerUrl: `https://play.7sefun.top/?url=${encodeURIComponent(realUrl)}`, isBlockedIframe: false };
                    }
                    if (parsed.from === 'ndx' || parsed.from === 'aafun2' || parsed.from === 'CYDD1') {
                        const addonUrl = `https://www.7sefun.top/addons/dp/player/index.php?key=0&id=${parsed.id || 0}&uid=0&from=${parsed.from}&url=${encodeURIComponent(realUrl)}`;
                        return { playerUrl: addonUrl, isBlockedIframe: false };
                    }

                    // 4. 若仍為 lmm85.com 且未成功解密，嘗試偵測同一部動漫的同集備援線路 (Line 1/Line 2)
                    if (realUrl.includes('lmm85.com')) {
                        const playMatch = playUrl.match(/\/vodplay\/(\d+)-(\d+)-(\d+)\.html/);
                        if (playMatch) {
                            const [_, vodId, curLine, epIdx] = playMatch;
                            const altLine = curLine === '1' ? '2' : '1';
                            const altUrl = `https://www.7sefun.top/vodplay/${vodId}-${altLine}-${epIdx}.html`;
                            try {
                                const altRes = await fetchWithTimeout(altUrl, {
                                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
                                }, 5000);
                                if (altRes.ok) {
                                    const altHtml = await altRes.text();
                                    const altAaaa = altHtml.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})<\/script>/);
                                    if (altAaaa) {
                                        const altParsed = JSON.parse(altAaaa[1].trim());
                                        let altReal = altParsed.url;
                                        if (altParsed.encrypt === 2) altReal = decodeURIComponent(Buffer.from(altParsed.url, 'base64').toString('utf-8'));
                                        else if (altParsed.encrypt === 1) altReal = unescape(altParsed.url);
                                        if (altReal && (/\.(mp4|m3u8)(\?.*)?$/i.test(altReal) || (!altReal.includes('lmm85.com')))) {
                                            return { playerUrl: altReal, isDirectStream: /\.(mp4|m3u8)(\?.*)?$/i.test(altReal) };
                                        }
                                    }
                                }
                            } catch (_) {}
                        }
                        // 最終標記為受跨域 SAMEORIGIN 阻擋之線路，前端渲染安全降級卡片
                        return { playerUrl: realUrl, isBlockedIframe: true };
                    }

                    return { playerUrl: realUrl, isBlockedIframe: false };
                }
            } catch (e) {
                console.warn('[7sefun Parse player_aaaa error]:', e.message);
            }
        }

        // 降級嘗試解析 iframe src
        const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (iframeMatch && iframeMatch[1]) {
            const link = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `https://www.7sefun.top${iframeMatch[1]}`;
            return { playerUrl: link, isBlockedIframe: link.includes('lmm85.com') };
        }
        return { playerUrl: playUrl, isBlockedIframe: playUrl.includes('lmm85.com') };
    } catch (e) {
        console.warn('[7sefun crawlPlayer failed]:', e.message);
        return { playerUrl: playUrl, isBlockedIframe: playUrl.includes('lmm85.com') };
    }
}

// 5. Girigirilove (ani.girigirilove.com) 資源搜尋模組
async function crawlGiriSearch(keyword) {
    try {
        const url = `https://share.acgnx.cc/search.php?keyword=${encodeURIComponent(keyword)}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://ani.girigirilove.com/' }
        }, 8000);
        if (!res.ok) return [];
        const html = await res.text();
        const results = [];
        const re = /<a[^>]+href="(show-[a-zA-Z0-9]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        const seen = new Set();
        while ((m = re.exec(html)) !== null) {
            const href = m[1];
            const title = m[2].replace(/<[^>]+>/g, '').trim();
            if (title && !seen.has(href)) {
                seen.add(href);
                results.push({
                    title: title,
                    detailUrl: `https://share.acgnx.cc/${href}`,
                    cover: 'https://ani.girigirilove.com/brand/icon.png',
                    source: 'Giri'
                });
                if (results.length >= 12) break;
            }
        }
        return results;
    } catch (e) {
        console.warn('[Giri Search failed]:', e.message);
        return [];
    }
}

async function crawlGiriEpisodes(detailUrl) {
    try {
        const res = await fetchWithTimeout(detailUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, 8000);
        if (!res.ok) return [];
        const html = await res.text();
        const magnetMatch = html.match(/(magnet:\?xt=urn:btih:[a-zA-Z0-9]+)/i);
        const magnet = magnetMatch ? magnetMatch[1] : '';
        return [{
            name: 'BT 磁力資源連結 (可貼入下載器 / 播放器)',
            playUrl: magnet || detailUrl
        }];
    } catch (e) {
        return [];
    }
}

// 彈彈play 開放平台 (dandanplay) 彈幕接入模組
async function fetchDandanplayDanmaku(animeTitle, episodeIndex = 1, appId = '', appSecret = '') {
    const finalAppId = (appId || process.env.DANDANPLAY_APP_ID || '').trim();
    const finalAppSecret = (appSecret || process.env.DANDANPLAY_APP_SECRET || '').trim();

    if (!finalAppId || !finalAppSecret) {
        return null;
    }

    try {
        // 1. 搜尋動漫與集數
        const searchPath = '/api/v2/search/episodes';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const rawSearchSig = finalAppId + timestamp + searchPath + finalAppSecret;
        const searchSig = crypto.createHash('sha256').update(rawSearchSig).digest('base64');

        const searchUrl = `https://api.dandanplay.net${searchPath}?anime=${encodeURIComponent(animeTitle)}`;
        const searchRes = await fetchWithTimeout(searchUrl, {
            headers: {
                'X-AppId': finalAppId,
                'X-Timestamp': timestamp,
                'X-Signature': searchSig,
                'Accept': 'application/json'
            }
        }, 8000);

        if (!searchRes.ok) return null;
        const searchData = await searchRes.json();
        const episodes = searchData.animes?.flatMap(a => a.episodes || []) || [];

        if (episodes.length === 0) return null;

        // 匹配集數 (嚴格分集匹配，絕不盲目 fallback 至第 1 集，確保各集彈幕獨立精確)
        let targetEp = episodes.find(e => parseInt(e.episodeNumber, 10) === episodeIndex)
                    || episodes.find(e => (e.episodeTitle || '').includes(`第${episodeIndex}`))
                    || episodes.find(e => (e.episodeTitle || '').includes(String(episodeIndex).padStart(2, '0')));
        if (!targetEp) {
            if (episodeIndex === 1 && episodes.length > 0) {
                targetEp = episodes[0];
            } else {
                return null;
            }
        }
        const episodeId = targetEp.episodeId;

        // 2. 獲取彈幕（附帶全網關聯彈幕 withRelated=true，自動繁體中文轉換 chConvert=1）
        const commentPath = `/api/v2/comment/${episodeId}`;
        const rawCommentSig = finalAppId + timestamp + commentPath + finalAppSecret;
        const commentSig = crypto.createHash('sha256').update(rawCommentSig).digest('base64');

        const commentUrl = `https://api.dandanplay.net${commentPath}?withRelated=true&chConvert=1`;
        const commentRes = await fetchWithTimeout(commentUrl, {
            headers: {
                'X-AppId': finalAppId,
                'X-Timestamp': timestamp,
                'X-Signature': commentSig,
                'Accept': 'application/json'
            }
        }, 10000);

        if (!commentRes.ok) return null;
        const commentData = await commentRes.json();
        const comments = commentData.comments || [];

        return comments.slice(0, 150).map(c => {
            const pParts = (c.p || '').split(',');
            return {
                time: Math.floor(parseFloat(pParts[0]) || 0),
                color: '#' + (parseInt(pParts[2], 10) || 16777215).toString(16).padStart(6, '0'),
                content: c.m
            };
        });
    } catch (err) {
        console.log('[Kazumi Dandanplay Error]:', err.message);
        return null;
    }
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

        // 3.1 路由 B-2: 解析 Bilibili 真實直連 MP4 串流 /api/kazumi/bilibili-playurl?bvid={bvid}&cid={cid}&url={url}
        else if (pathname === '/api/kazumi/bilibili-playurl') {
            let bvid = getQueryParam(parsedUrl, 'bvid') || '';
            let cid = getQueryParam(parsedUrl, 'cid') || '';
            const rawUrl = getQueryParam(parsedUrl, 'url') || '';

            // 從傳入的網址或參數中智能萃取 bvid、season_id 或 ep_id
            const searchTarget = rawUrl || bvid;
            const bvMatch = searchTarget.match(/(BV[a-zA-Z0-9]{10})/i);
            const ssMatch = searchTarget.match(/bangumi\/play\/ss(\d+)/i) || searchTarget.match(/season_id=(\d+)/i);
            const epMatch = searchTarget.match(/bangumi\/play\/ep(\d+)/i) || searchTarget.match(/ep_id=(\d+)/i);

            if (bvMatch) {
                bvid = bvMatch[1];
            }

            try {
                // 若為 B 站番劇/電影 (ss/ep)，透過官方 pgc 接口反查對應集數的真實 bvid 與 cid
                if ((!bvid || ssMatch || epMatch) && (ssMatch || epMatch)) {
                    let pgcSeasonUrl = '';
                    if (ssMatch) {
                        pgcSeasonUrl = `https://api.bilibili.com/pgc/view/web/season?season_id=${ssMatch[1]}`;
                    } else if (epMatch) {
                        pgcSeasonUrl = `https://api.bilibili.com/pgc/view/web/season?ep_id=${epMatch[1]}`;
                    }

                    if (pgcSeasonUrl) {
                        const pgcRes = await fetchWithTimeout(pgcSeasonUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/'
                            }
                        }, 5000);
                        if (pgcRes.ok) {
                            const pgcData = await pgcRes.json();
                            if (pgcData.code === 0 && pgcData.result && Array.isArray(pgcData.result.episodes) && pgcData.result.episodes.length > 0) {
                                let targetEp = pgcData.result.episodes[0];
                                if (epMatch) {
                                    const matchFound = pgcData.result.episodes.find(e => e.id == epMatch[1]);
                                    if (matchFound) targetEp = matchFound;
                                }
                                if (targetEp.bvid) bvid = targetEp.bvid;
                                if (targetEp.cid) cid = targetEp.cid.toString();
                            }
                        }
                    }
                }

                if (!bvid && !cid) {
                    return sendJson(res, 400, { success: false, error: '未能識別有效的 Bilibili BV號或番劇集數' });
                }

                let targetCid = cid;
                if (!targetCid || targetCid === '0') {
                    const plUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
                    const plRes = await fetchWithTimeout(plUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }, 5000);
                    if (plRes.ok) {
                        const plJson = await plRes.json();
                        if (plJson.code === 0 && plJson.data && plJson.data.length > 0) {
                            targetCid = plJson.data[0].cid;
                        }
                    }
                }

                if (targetCid) {
                    // 1. 優先嘗試常規 UGC 直連接口 (HTML5 MP4)
                    const playApiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(targetCid)}&qn=64&fnval=0&platform=html5`;
                    const playRes = await fetchWithTimeout(playApiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://www.bilibili.com/'
                        }
                    }, 6000);

                    if (playRes.ok) {
                        const playJson = await playRes.json();
                        if (playJson.code === 0 && playJson.data && playJson.data.durl && playJson.data.durl.length > 0) {
                            const rawStreamUrl = playJson.data.durl[0].url;
                            const proxyStreamUrl = `/api/kazumi/stream-proxy?url=${encodeURIComponent(rawStreamUrl)}`;
                            return sendJson(res, 200, {
                                success: true,
                                isDirectStream: true,
                                streamUrl: proxyStreamUrl,
                                rawUrl: rawStreamUrl,
                                bvid: bvid,
                                cid: targetCid,
                                duration: (playJson.data.durl[0].length / 1000) || 0,
                                size: playJson.data.durl[0].size || 0
                            });
                        }
                    }

                    // 2. 次要嘗試番劇 PGC 直連接口 (若為番劇作品)
                    const pgcPlayApiUrl = `https://api.bilibili.com/pgc/player/web/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(targetCid)}&qn=64&fnval=0&platform=html5`;
                    const pgcPlayRes = await fetchWithTimeout(pgcPlayApiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://www.bilibili.com/'
                        }
                    }, 6000);

                    if (pgcPlayRes.ok) {
                        const pgcPlayJson = await pgcPlayRes.json();
                        const durlList = pgcPlayJson?.result?.durl || pgcPlayJson?.data?.durl;
                        if (durlList && durlList.length > 0) {
                            const rawStreamUrl = durlList[0].url;
                            const proxyStreamUrl = `/api/kazumi/stream-proxy?url=${encodeURIComponent(rawStreamUrl)}`;
                            return sendJson(res, 200, {
                                success: true,
                                isDirectStream: true,
                                streamUrl: proxyStreamUrl,
                                rawUrl: rawStreamUrl,
                                bvid: bvid,
                                cid: targetCid,
                                duration: (durlList[0].length / 1000) || 0,
                                size: durlList[0].size || 0
                            });
                        }
                    }
                }

                return sendJson(res, 200, {
                    success: true,
                    isDirectStream: false,
                    bvid: bvid,
                    fallbackIframeUrl: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&as_wide=1&danmaku=0`
                });
            } catch (err) {
                return sendJson(res, 200, {
                    success: true,
                    isDirectStream: false,
                    bvid: bvid,
                    fallbackIframeUrl: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&as_wide=1&danmaku=0`
                });
            }
        }

        // 4. 路由 C: 彈幕數據 /api/kazumi/danmaku (支援 彈彈play 全網聚合 與 Bilibili 官方即時彈幕雙引擎自由切換)
        else if (pathname === '/api/kazumi/danmaku') {
            let cid = getQueryParam(parsedUrl, 'cid');
            const anime = getQueryParam(parsedUrl, 'anime') || getQueryParam(parsedUrl, 'title');
            const epNum = parseInt(getQueryParam(parsedUrl, 'ep') || '1', 10);
            const appId = getQueryParam(parsedUrl, 'appId');
            const appSecret = getQueryParam(parsedUrl, 'appSecret');
            const sourcePref = getQueryParam(parsedUrl, 'source') || 'bilibili'; // 預設優先直連 Bilibili

            // A. 若使用者選用彈彈play 且有金鑰，優先嘗試彈彈play 全網聚合彈幕 (B站+動畫瘋+騰訊等)
            if (sourcePref === 'dandanplay' && anime && appId && appSecret) {
                const dandanDanmaku = await fetchDandanplayDanmaku(anime, epNum, appId, appSecret);
                if (dandanDanmaku && dandanDanmaku.length > 0) {
                    return sendJson(res, 200, {
                        success: true,
                        source: 'dandanplay',
                        count: dandanDanmaku.length,
                        danmaku: dandanDanmaku
                    });
                }
            }

            // B. 若無 cid 但有片名（或使用者選擇 Bilibili 官方直連），依集數獨立檢索各集彈幕最多之真實 CID
            if (!cid && anime) {
                try {
                    // 淨化片名 (去除集數、季數與多餘標點)
                    const cleanKeyword = anime
                        .replace(/[【】\[\]()（）]/g, ' ')
                        .replace(/第\s*\d+\s*[集話期]/g, '')
                        .replace(/(Season\s*\d+|S\d+)/gi, '')
                        .trim();

                    const epPad = String(epNum).padStart(2, '0');
                    const epRegex = new RegExp(`(?:第\\s*(?:0?${epNum})\\s*[話集期]|ep\\s*(?:0?${epNum})\\b|\\b0?${epNum}\\s*[話集]|\\bEP${epNum}\\b|\\b${epPad}\\b)`, 'i');
                    const noiseRegex = /(导视|吐槽|漫谈|手办|联动|第五人格|reaction|原声带|OST|纯音乐|二创|解说)/i;

                    // 1. 先搜尋特定集數候選詞組合 (包含第X話、第X集、EP X、0X)
                    const searchQueries = [
                        `${cleanKeyword} 第${epNum}話`,
                        `${cleanKeyword} 第${epPad}話`,
                        `${cleanKeyword} 第${epNum}集`,
                        `${cleanKeyword} 第${epPad}集`,
                        `${cleanKeyword} EP${epNum}`,
                        `${cleanKeyword} EP${epPad}`
                    ];

                    let matchedCandidates = [];
                    for (const q of searchQueries) {
                        const bSearchUrl = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}&order=dm`;
                        const bRes = await fetchWithTimeout(bSearchUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/',
                                'Accept': 'application/json, text/plain, */*'
                            }
                        }, 3500);

                        if (bRes.ok) {
                            const bData = await bRes.json();
                            const items = bData?.data?.result;
                            if (Array.isArray(items) && items.length > 0) {
                                for (const it of items) {
                                    const cleanT = (it.title || '').replace(/<[^>]+>/g, '');
                                    const dm = parseInt(it.danmaku, 10) || 0;
                                    // 排除顯而易見的雜訊 (遊戲聯動、導視等)
                                    if (noiseRegex.test(cleanT)) continue;
                                    // 檢查標題是否吻合該集
                                    if (epRegex.test(cleanT) || epNum === 1) {
                                        matchedCandidates.push({ bvid: it.bvid, title: cleanT, danmaku: dm });
                                    }
                                }
                                if (matchedCandidates.length >= 6) break;
                            }
                        }
                    }

                    // 依該集彈幕數量 (danmaku) 嚴格降序排序，確保選出該集最多彈幕
                    matchedCandidates.sort((a, b) => b.danmaku - a.danmaku);

                    // 嘗試從候選視頻中解析出真實 CID
                    for (const cand of matchedCandidates) {
                        const pageRes = await fetchWithTimeout(`https://api.bilibili.com/x/player/pagelist?bvid=${cand.bvid}`, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                        }, 3000);
                        if (pageRes.ok) {
                            const pageData = await pageRes.json();
                            const pages = pageData?.data;
                            if (Array.isArray(pages) && pages.length > 0) {
                                // 若為多P視頻：先按 part 匹配集數，次按 index 匹配
                                if (pages.length >= epNum) {
                                    const targetP = pages.find(p => epRegex.test(p.part)) || pages[epNum - 1];
                                    if (targetP?.cid) {
                                        cid = targetP.cid.toString();
                                        break;
                                    }
                                } else if (pages.length === 1 && epRegex.test(cand.title)) {
                                    // 單集獨立視頻 (標題明確標註為該集)
                                    cid = pages[0].cid.toString();
                                    break;
                                }
                            }
                        }
                    }

                    // 2. 若特定集數搜尋未果，搜尋合集 (Multi-P) 全集視頻
                    if (!cid) {
                        const allSearchUrl = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(cleanKeyword)}&order=dm`;
                        const allRes = await fetchWithTimeout(allSearchUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                                'Referer': 'https://www.bilibili.com/',
                                'Accept': 'application/json, text/plain, */*'
                            }
                        }, 3500);

                        if (allRes.ok) {
                            const allData = await allRes.json();
                            const allItems = allData?.data?.result;
                            if (Array.isArray(allItems)) {
                                for (const it of allItems.slice(0, 8)) {
                                    const cleanT = (it.title || '').replace(/<[^>]+>/g, '');
                                    if (noiseRegex.test(cleanT)) continue;

                                    const pageRes = await fetchWithTimeout(`https://api.bilibili.com/x/player/pagelist?bvid=${it.bvid}`, {
                                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
                                    }, 3000);
                                    if (pageRes.ok) {
                                        const pageData = await pageRes.json();
                                        const pages = pageData?.data;
                                        // 必須含有對應集數，嚴禁 epNum > 1 時回退到 pages[0]！
                                        if (Array.isArray(pages) && pages.length >= epNum) {
                                            const targetP = pages.find(p => epRegex.test(p.part)) || pages[epNum - 1];
                                            if (targetP?.cid) {
                                                cid = targetP.cid.toString();
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (bSearchErr) {
                    console.log('[Kazumi Danmaku] B站分集 CID 動態反查略過:', bSearchErr.message);
                }
            }

            // C. 嘗試以 CID 抓取 B站官方即時彈幕 (放寬抓取上限至 2000 條，極大化彈幕量)
            if (cid && /^\d+$/.test(cid)) {
                try {
                    const dmUrl = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
                    const response = await fetchWithTimeout(dmUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                            'Referer': 'https://www.bilibili.com/'
                        }
                    }, 5500);

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
                            if (list.length >= 2000) break; // 大幅提升彈幕上限至 2000 條！
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

            // D. 無第三方彈幕資料時回傳空陣列 (不生成任何預設或虛擬彈幕，保持畫面純淨)
            return sendJson(res, 200, {
                success: true,
                source: 'empty',
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

            if (parsedTarget.hostname.includes('bilibili') || parsedTarget.hostname.includes('hdslb') || parsedTarget.hostname.includes('akamaized.net') || parsedTarget.hostname.includes('bilivideo')) {
                proxyHeaders['Referer'] = 'https://www.bilibili.com/';
            }

            const controller = new AbortController();
            let isAborted = false;

            const cleanupStream = () => {
                if (isAborted) return;
                isAborted = true;
                try {
                    controller.abort();
                } catch (e) {}
            };

            req.on('close', cleanupStream);
            res.on('close', cleanupStream);

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

                // 關鍵加固：徹底攔截並靜默處理串流的 error 事件，防止 AbortError 觸發 Node.js Unhandled 'error' event 導致伺服器崩潰！
                nodeStream.on('error', (streamErr) => {
                    // 客戶端中斷、換源、拖曳時間軸或關閉劇院產生的 AbortError / ECONNRESET 屬於正常連線中斷
                    try {
                        if (!nodeStream.destroyed) nodeStream.destroy();
                    } catch (e) {}
                    if (!res.writableEnded) {
                        try { res.end(); } catch (e) {}
                    }
                });

                res.on('error', (resErr) => {
                    cleanupStream();
                    try {
                        if (!nodeStream.destroyed) nodeStream.destroy();
                    } catch (e) {}
                });

                nodeStream.pipe(res);
            } catch (err) {
                if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || isAborted) return;
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
                    { id: 'Giri', name: 'Girigirilove (BT 資源索引庫)', baseURL: 'https://ani.girigirilove.com/', version: '1.0' },
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
                if (source === 'Giri') {
                    results = await crawlGiriSearch(q);
                } else if (source === '7sefun') {
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
                if (detailUrl.includes('acgnx.cc') || detailUrl.includes('girigirilove')) {
                    episodes = await crawlGiriEpisodes(detailUrl);
                } else if (detailUrl.includes('7sefun')) {
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
                let isBlockedIframe = false;
                let isDirectStream = false;
                if (playUrl.includes('agedm.io') || playUrl.includes('/play/')) {
                    const result = await crawlAgePlayer(playUrl);
                    if (typeof result === 'object' && result !== null) {
                        playerUrl = result.playerUrl;
                        isDirectStream = !!result.isDirectStream;
                    } else {
                        playerUrl = result;
                    }
                } else if (playUrl.includes('7sefun')) {
                    const result = await crawl7sefunPlayer(playUrl);
                    if (typeof result === 'object' && result !== null) {
                        playerUrl = result.playerUrl;
                        isBlockedIframe = !!result.isBlockedIframe;
                        isDirectStream = !!result.isDirectStream;
                    } else {
                        playerUrl = result;
                    }
                } else if (playUrl.includes('.m3u8') || playUrl.includes('.mp4')) {
                    playerUrl = playUrl;
                    isDirectStream = true;
                } else {
                    const result = await crawlAgePlayer(playUrl);
                    if (typeof result === 'object' && result !== null) {
                        playerUrl = result.playerUrl;
                        isDirectStream = !!result.isDirectStream;
                    } else {
                        playerUrl = result;
                    }
                }

                if (!playerUrl) {
                    return sendJson(res, 404, { success: false, error: '未找到播放器網址' });
                }
                return sendJson(res, 200, {
                    success: true,
                    playerUrl: playerUrl,
                    isBlockedIframe: isBlockedIframe,
                    isDirectStream: isDirectStream
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
