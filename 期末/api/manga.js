// 【總說明】api/manga.js：漫畫（條漫）功能的後端，server.js 把 /api/manga/* 交給 handleMangaRoute。
// 資料來源有兩個內建網站 + 使用者自訂規則：
//  - 包子漫畫 (baozimh/webmota)：抓 HTML 網頁，用正規表示式取出資料
//  - 拷貝漫畫 (CopyManga)：呼叫它的 JSON API，有多個鏡像網址輪流備援
//  - 自訂規則：交給 api/custom-rules.js 處理
// 提供的 API：
//  GET  /api/manga/search?q=            搜尋（兩個來源同時查再合併）
//  GET  /api/manga/chapters?mangaId=    章節列表
//  GET  /api/manga/pages?mangaId=&chapterId=  某一話的圖片網址
//  GET  /api/manga/proxy?url=&ref=      圖片代理（繞過防盜連）
//  POST /api/manga/custom-search | custom-chapters | custom-pages   自訂規則
// 對外抓取的部分都經過 safe-fetch.js 的檢查，避免被拿去打內網（SSRF）。
/**
 * Tachimanga 條漫閱讀器後端模組 (BaoziManga / CopyManga 全網漫畫聚合引擎)
 * 採用 Node.js 原生 fetch / http 模組，零相依、高效率
 */
const https = require('https');
const http = require('http');
const url = require('url');
const customRules = require('./custom-rules');
const { readJsonBody, assertUrlShape, safeLookup, safeFetchText, UnsafeUrlError } = require('./safe-fetch');

// 拷貝漫畫 API 的多個鏡像網域。網站常被封鎖或換網址，所以準備多個，一個失敗就換下一個。
const COPYMANGA_HOSTS = [
    'api.manga2025.com',
    'api.copy3000.com',
    'api.copy4000.com',
    'api.2026copy.com',
    'api.copy-manga.com',
    'api.mangacopy.com'
];

// toSimpleChinese(str)：把繁體字轉成簡體字（只含常用動漫字的小對照表）。
//  參數 str 字串；回傳轉換後字串（空值回傳 ""）。用途：兩個網站有的用繁體、有的用簡體，搜尋時要兩種都試。
//  做法：逐字查表 map，查不到就保留原字。
// 繁簡字元轉換映射表（動漫漫畫高頻常用字）
function toSimpleChinese(str) {
    if (!str) return '';
    const map = {
        '轉': '转', '戰': '战', '迴': '回', '蓮': '莲', '賊': '贼', '擊': '击',
        '滅': '灭', '刃': '刃', '鏈': '链', '鋸': '锯', '電': '电', '間': '间',
        '諜': '谍', '職': '职', '國': '国', '異': '异', '體': '体', '隊': '队',
        '寶': '宝', '機': '机', '樂': '乐', '戀': '恋', '絕': '绝', '地': '地',
        '話': '话', '捲': '卷', '貓': '猫', '靈': '灵', '魂': '魂', '貴': '贵',
        '族': '族', '熊': '熊', '公': '公', '主': '主', '王': '王', '子': '子',
        '婚': '婚', '座': '座', '念': '念', '魔': '魔', '勇': '勇', '者': '者',
        '冒': '冒', '險': '险', '學': '学', '園': '园', '術': '术', '過': '过',
        '家': '家', '酒': '酒', '拳': '拳', '超': '超', '人': '人', '無': '无',
        '航': '航', '海': '海', '進': '进', '巨': '巨', '鬼': '鬼', '咒': '咒'
    };
    return str.split('').map(c => map[c] || c).join('');
}

// generateTitleVariants(title, alias)：產生一組「可能搜得到的標題寫法」。
//  包含：原標題、別名（用逗號 / | / 斜線切開）、各自的簡體版、去掉括號標點空白後的版本。
//  用 Set 自動去除重複。回傳陣列，後面備援搜尋會一個個試。
// 產生多維候選標題（包含原名、別名、繁簡體與標點符號清洗）
function generateTitleVariants(title = '', alias = '') {
    const set = new Set();
    if (title && title.trim()) set.add(title.trim());
    if (alias && alias.trim()) {
        alias.split(/[,，|/]/).map(s => s.trim()).filter(Boolean).forEach(a => set.add(a));
    }
    const current = Array.from(set);
    for (const item of current) {
        const simp = toSimpleChinese(item);
        if (simp) set.add(simp);
        const cleaned = item.replace(/[【】\[\]\(\)（）\-_~≡\s]/g, '').trim();
        if (cleaned) {
            set.add(cleaned);
            set.add(toSimpleChinese(cleaned));
        }
    }
    return Array.from(set);
}

// httpGetJson(targetUrl, headers)：發 GET 請求並把回應解析成 JSON，回傳 Promise。
//  預設標頭模仿拷貝漫畫的 App（Dart/3.0），不然 API 會拒絕。遇到 3xx 轉址就用新網址再來一次；
//  逾時 10 秒、JSON 解析失敗都會 reject（丟錯）。
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

// sendJson(res, statusCode, data)：統一回傳 JSON 的小工具（含 CORS 標頭）。
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

// proxyImage(imgUrl, res, customReferer)：圖片反向代理。
//  為什麼要代理：漫畫網站會檢查 Referer（請求從哪個網頁來），直接在本站網頁載入它的圖片會被擋（防盜連），
//  所以改成由本站伺服器去抓、帶上正確的 Referer，再把圖片轉給瀏覽器。
//  參數：imgUrl 原圖網址；res 回應；customReferer 自訂規則指定的來源網頁。
//  錯誤：沒給網址 400；網址不安全 400；目標不是圖片 415；連線失敗 502。
// 代理圖片傳輸 (繞過防盜鏈或證書問題)
function proxyImage(imgUrl, res, customReferer = '') {
    if (!imgUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('請提供 imgUrl');
    }

    try {
        // assertUrlShape 先擋 localhost / 內網網址；真正連線時 lookup: safeLookup 再檢查 DNS 結果（雙重防 SSRF）。
        const parsed = assertUrlShape(imgUrl); // 擋掉 localhost / 內網 (DNS 結果由 safeLookup 在連線時檢查)
        const client = parsed.protocol === 'https:' ? https : http;
        // 依圖片網址的網域決定 Referer：包子漫畫、拷貝漫畫用固定的；自訂規則用前端帶來的來源站（需是 http/https 網址）。
        let referer = '';
        if (parsed.hostname.includes('bzcdn.net') || parsed.hostname.includes('baozimh')) {
            referer = 'https://www.webmota.com/';
        } else if (parsed.hostname.includes('mangafunb') || parsed.hostname.includes('copymanga')) {
            referer = 'https://www.mangacopy.com/';
        } else if (/^https?:\/\//i.test(customReferer)) {
            referer = customReferer; // 自訂規則的圖片：用來源站當 Referer 繞過防盜鏈
        }

        const req = client.request(parsed, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': referer
            },
            lookup: safeLookup,
            timeout: 15000
        }, (imgRes) => {
            // 安全：只轉送 Content-Type 是 image/ 的內容；否則有人可以讓代理回傳 HTML，在本站網域下執行惡意腳本（XSS）。
            //  Cache-Control 讓瀏覽器快取一天，翻頁更快。imgRes.pipe(res) 用串流轉送，不佔記憶體。
            // 只轉送圖片，避免代理被拿來在本站網域下輸出任意 HTML
            const type = String(imgRes.headers['content-type'] || '');
            if (type && !/^(image\/|application\/octet-stream|binary\/octet-stream)/i.test(type)) {
                imgRes.resume();
                res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('目標不是圖片');
            }
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

// 包子漫畫的三個步驟：搜尋 -> 章節 -> 頁面圖片。BAOZI_SEARCH_HOSTS 是多個鏡像網址。
// 1. 包子漫畫 (Webmota / Baozimh 多鏡像備援) 搜尋解析器
const BAOZI_SEARCH_HOSTS = [
    'https://www.webmota.com',
    'https://cn.baozimh.com',
    'https://www.baozimh.com'
];

// searchBaoziManga(keyword)：搜尋包子漫畫，回傳統一格式的陣列 [{id,title,cover,author,brief,source}]。
//  依序試每個鏡像：請求失敗 / 逾時（5 秒）/ 沒結果就換下一個；全部失敗回傳空陣列（不丟錯，讓另一個來源仍可使用）。
async function searchBaoziManga(keyword) {
    for (const host of BAOZI_SEARCH_HOSTS) {
        try {
            const searchUrl = `${host}/search?q=${encodeURIComponent(keyword)}`;
            const res = await fetch(searchUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) continue;
            const html = await res.text();
            // 正規表示式（用 /g 搭配 exec 迴圈逐筆取出）：找 <a href="/comic/xxx" ... title="作品名"> 後面最近的 <amp-img src="封面">。
            //  三個括號依序是：[1] 作品路徑、[2] 標題、[3] 封面圖網址。[\s\S]*? 代表「跨行的最短匹配」。
            //  id 加上 baozi_ 前綴，之後才分得出是哪個來源。以 id 去重。
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
            if (results.length > 0) return results;
        } catch (e) {
            // 超時或網路波動時自動嘗試下一個備援節點，杜絕主執行緒被卡死或拋出錯誤
            continue;
        }
    }
    return [];
}

// getBaoziChapters(rawId)：取得作品的章節列表。回傳 [{id(章節連結), title, index}]。
//  把 baozi_ 前綴去掉還原成真正作品代號；章節連結長得像 /user/page_direct?...，用正規表示式取出連結與標題 span。
//  一個都找不到就丟錯，讓上層改走備援。
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

// getBaoziPages(pageDirectUrl)：取一話的所有圖片網址（陣列）。
//  章節網址來自前端、可能是任意網址，所以這裡用 safeFetchText（有 SSRF 防護）。圖片在 <amp-img src="..."> 裡。
// 3. 包子漫畫單話全頁圖片解析
async function getBaoziPages(pageDirectUrl) {
    const fullUrl = pageDirectUrl.startsWith('http') ? pageDirectUrl : `https://www.webmota.com${pageDirectUrl}`;
    // chapterId 來自前端，可能是任意網址：走 safeFetchText (擋內網、逐跳檢查轉址、限制大小)
    const res = await safeFetchText(fullUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeoutMs: 12000
    });
    if (res.status >= 400) throw new Error('讀取章節圖片頁面失敗: ' + res.status);
    const html = res.text;
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

// searchCopyManga(keyword)：呼叫拷貝漫畫的搜尋 API，輪流嘗試各鏡像。
//  回傳統一格式陣列；id 加上 copy_ 前綴；全部失敗回傳空陣列。
// 4. CopyManga 搜尋解析器 (備援)
async function searchCopyManga(keyword) {
    for (const host of COPYMANGA_HOSTS) {
        try {
            const apiUrl = `https://${host}/api/v3/search/comic?format=json&platform=3&limit=24&q=${encodeURIComponent(keyword)}`;
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

// searchManga(keyword)：同時（平行）搜兩個來源，各自的結果合併成一個陣列。
//  Promise.allSettled 的特點：就算其中一個失敗也不會整個失敗，失敗的當作空陣列。
// 漫畫搜尋核心 (雙來源聚合：包子漫畫 + 拷貝漫畫兩邊並存，明確標記來源)
async function searchManga(keyword) {
    const p1 = searchBaoziManga(keyword);
    const p2 = searchCopyManga(keyword);
    const [list1, list2] = await Promise.allSettled([p1, p2]);
    const baoziList = list1.status === 'fulfilled' ? list1.value : [];
    const copyList = list2.status === 'fulfilled' ? list2.value : [];

    // 兩邊並存：完整保留包子漫畫與 CopyManga 的搜尋結果，不進行同名遮蔽
    const merged = [...baoziList, ...copyList];
    return merged;
}

// getMangaChapters(mangaId, title, alias, token)：取章節列表，多層備援，盡量不讓使用者看到錯誤：
//  1. 包子漫畫的作品直接用包子解析
//  2. 拷貝漫畫：逐個鏡像呼叫章節 API（先 default 分組，沒資料再查詳情找其他分組）；有 token 就帶 Authorization
//  3. 都失敗：用標題的各種繁簡 / 別名寫法去包子漫畫搜尋，找到就用它的章節
//  4. 再不行，把 id 直接當包子的作品代號試一次
//  5. 最後回傳空陣列（前端顯示「沒有章節」，而不是 500 錯誤）
// 取得話數章節列表 (支援包子漫畫與拷貝漫畫，具備繁簡互轉與多詞交叉智慧備援)
async function getMangaChapters(mangaId, title = '', alias = '', token = '') {
    if (mangaId.startsWith('baozi_') || mangaId.includes('-')) {
        try {
            return await getBaoziChapters(mangaId);
        } catch (e) {
            console.warn('[Baozi chapters failed, trying fallback]:', e.message);
        }
    }

    const cleanId = mangaId.replace(/^copy_/, '');
    const userToken = token || process.env.COPYMANGA_TOKEN || '';
    let lastError = null;

    // 1. 嘗試直接調用 CopyManga 多節點（對齊 LittleSurvival/copymanga-copy20 最新多節點健康線路）
    for (const host of COPYMANGA_HOSTS) {
        try {
            // 先嘗試預設分組 default
            let apiUrl = `https://${host}/api/v3/comic/${encodeURIComponent(cleanId)}/group/default/chapters?limit=500&offset=0&platform=3`;
            const reqHeaders = { 'version': '3.0.0', 'platform': '3', 'source': 'copyApp' };
            if (userToken) reqHeaders['Authorization'] = `Token ${userToken}`;
            let res = await httpGetJson(apiUrl, reqHeaders);

            // 若 default 無資料，嘗試探測 comic2 詳情獲取其他真實 groups
            if (!res || !res.results || !Array.isArray(res.results.list) || res.results.list.length === 0) {
                try {
                    const detailRes = await httpGetJson(`https://${host}/api/v3/comic2/${encodeURIComponent(cleanId)}?platform=3`, reqHeaders);
                    const groups = detailRes?.results?.groups;
                    if (groups && typeof groups === 'object') {
                        const groupKeys = Object.keys(groups);
                        for (const gk of groupKeys) {
                            if (gk === 'default') continue;
                            const gUrl = `https://${host}/api/v3/comic/${encodeURIComponent(cleanId)}/group/${encodeURIComponent(gk)}/chapters?limit=500&offset=0&platform=3`;
                            const gRes = await httpGetJson(gUrl, reqHeaders);
                            if (gRes && gRes.results && Array.isArray(gRes.results.list) && gRes.results.list.length > 0) {
                                res = gRes;
                                break;
                            }
                        }
                    }
                } catch (_) {}
            }

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

    // 2. 智慧標題多詞交叉備援（繁簡轉換 + 別名檢索，徹底解決 CopyManga 403/空章節問題）
    const candidateVariants = generateTitleVariants(title, alias);
    for (const variant of candidateVariants) {
        try {
            const bResults = await searchBaoziManga(variant);
            if (bResults && bResults.length > 0) {
                // 優先比對完全匹配或長度最接近的作品
                const matched = bResults.find(b => b.title.trim() === variant) || bResults[0];
                return await getBaoziChapters(matched.id);
            }
        } catch (_) {}
    }

    // 3. 嘗試以 cleanId 呼叫包子漫畫兜底
    try {
        return await getBaoziChapters(cleanId);
    } catch (_) {}

    // 4. 若全網源皆無該絕版/獨家作品，回傳友好空列表而非讓前端拋出 500 報錯崩潰
    return [];
}

// getChapterPages(mangaId, chapterId)：取某話圖片網址陣列。
//  包子來源 -> getBaoziPages；拷貝漫畫 -> 輪流問各鏡像的章節 API，成功就回傳圖片網址，全部失敗就丟最後一個錯誤。
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

// handleMangaRoute(req, res)：/api/manga 的總路由。用 if / else if 依 pathname 分派到各 API。
//  錯誤處理：最外層 try/catch；被 SSRF 防護擋下的錯誤回 403，其他回 500。
// 主路由處理器 (全面遵循 WHATWG URL 標準，消除 DEP0169 url.parse 棄用警告)
async function handleMangaRoute(req, res) {
    const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // CORS 預檢請求直接回 200。
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

        // chapters 參數說明：mangaId 作品 id；title / alias 用於備援搜尋；token 是使用者自己的拷貝漫畫登入 token（選填）。
        // 2. 取得漫畫話數章節: /api/manga/chapters?mangaId=xxx&title=xxx&alias=yyy&token=zzz
        else if (pathname === '/api/manga/chapters') {
            const mangaId = (query.mangaId || '').trim();
            const title = (query.title || '').trim();
            const alias = (query.alias || '').trim();
            const token = (query.token || '').trim();
            if (!mangaId) {
                return sendJson(res, 400, { success: false, error: '請提供漫畫 ID "mangaId"' });
            }
            const chapters = await getMangaChapters(mangaId, title, alias, token);
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

        // proxy：query.url 是原圖網址，query.ref 是自訂規則指定的 Referer。
        // 4. 圖片反向代理: /api/manga/proxy?url=xxx
        else if (pathname === '/api/manga/proxy') {
            const imgUrl = query.url;
            return proxyImage(imgUrl, res, query.ref || '');
        }

        // 自訂規則路由（只接受 POST）：網址最後一段是動作 search / chapters / pages，
        //  規則與參數放在 JSON body：{ rule, q | detailUrl | chapterUrl }。用 readJsonBody 讀取（有大小上限）。
        //  錯誤：被 SSRF 擋下 403；其他（對方網站掛了、規則寫錯）502。
        // 5. 使用者自訂漫畫規則 (POST，body 帶 { rule, q | detailUrl | chapterUrl })
        else if (pathname.startsWith('/api/manga/custom-')) {
            if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: '請使用 POST' });
            const action = pathname.slice('/api/manga/custom-'.length);
            try {
                const body = await readJsonBody(req);
                if (action === 'search') {
                    const q = String(body.q || '').trim();
                    if (!q) return sendJson(res, 400, { success: false, error: '請提供搜尋關鍵字 "q"' });
                    const { results, matched } = await customRules.mangaSearch(body.rule, q);
                    return sendJson(res, 200, { success: true, count: results.length, matched, results });
                }
                if (action === 'chapters') {
                    const chapters = await customRules.mangaChapters(body.rule, String(body.detailUrl || ''));
                    return sendJson(res, 200, { success: true, count: chapters.length, chapters });
                }
                if (action === 'pages') {
                    const pages = await customRules.mangaPages(body.rule, String(body.chapterUrl || ''));
                    return sendJson(res, 200, { success: true, count: pages.length, pages });
                }
                return sendJson(res, 404, { success: false, error: '未知的自訂規則操作' });
            } catch (err) {
                return sendJson(res, err instanceof UnsafeUrlError ? 403 : 502, { success: false, error: err.message });
            }
        }

        else {
            return sendJson(res, 404, { success: false, error: '找不到該漫畫 API 端點' });
        }
    } catch (err) {
        console.error('[Manga API Error]:', err.message);
        const blocked = err instanceof UnsafeUrlError || /本機或內網|內網位址/.test(err.message || '');
        return sendJson(res, blocked ? 403 : 500, { success: false, error: err.message });
    }
}

// 匯出路由處理器；其餘函式也匯出供其他模組（例如 kazumi.js）重用。
module.exports = {
    handleMangaRoute,
    searchManga,
    getMangaChapters,
    getChapterPages
};
