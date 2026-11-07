/**
 * 【檔案總說明】api/kazumi.js —— 動漫（Kazumi）後端模組
 *
 * 這個模組負責什麼：
 *   讓前端的「動漫劇院」可以搜尋動漫、找到集數、取得可播放的影片網址、載入彈幕。
 *   因為瀏覽器直接去抓別人的網站會被 CORS（跨網域限制）和防盜鏈擋住，
 *   所以由我們自己的伺服器代替瀏覽器去抓（爬蟲 / 代理），再把整理好的 JSON 回傳給前端。
 *
 * 怎麼被接上：server.js 裡有一行 [['/api/kazumi'], handleKazumiRoute]，
 *   只要網址以 /api/kazumi 開頭，就會交給本檔最下方的 handleKazumiRoute 處理。
 *
 * 提供的 API 路由（全部是 GET，除了 custom-* 是 POST）：
 *   /api/kazumi/search            Bangumi（bgm.tv）官方動漫資料搜尋（封面、評分、簡介）
 *   /api/kazumi/resolve           解析 Bilibili BV 號或一般串流網址，整理成統一格式
 *   /api/kazumi/bilibili-playurl  取得 Bilibili 真正可播放的 MP4 直連網址
 *   /api/kazumi/danmaku           取得彈幕（彈彈play 或 Bilibili）
 *   /api/kazumi/stream-proxy      影片串流代理（幫瀏覽器繞過防盜鏈與 CORS）
 *   /api/kazumi/rules             列出支援的爬蟲來源（AGE、Giri、7sefun）
 *   /api/kazumi/rule-search       用指定來源搜尋動漫
 *   /api/kazumi/rule-episodes     取得某部動漫的集數清單
 *   /api/kazumi/rule-play         取得某一集真正的播放器 / 影片網址
 *   /api/kazumi/custom-*          使用者自訂規則（POST，交給 custom-rules.js 處理）
 *
 * 資料流向：前端 -> 本模組 -> 外部網站（AGE、7sefun、Girigiri、Bilibili、Bangumi、dandanplay）
 *   -> 解析 HTML / JSON -> 整理成 JSON 回前端。本模組不使用資料庫，也沒有存檔，
 *   每次請求都是即時去抓。
 *
 * 安全重點：伺服器會去抓「使用者給的網址」，若不檢查，攻擊者可以讓伺服器去打內網或本機（SSRF）。
 *   所以所有對外連線都會先經過 safe-fetch.js 的 assertPublicUrl / safeRequestStream 檢查。
 */
/**
 * Web Library - Kazumi 動漫後端核心模組
 * 採用 Node.js 原生環境 (CommonJS, global fetch, stream, url)
 * 零依賴、免裝 npm 套件！支援載入 KazumiRules 外部規則爬蟲！
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 自訂規則引擎（使用者可以自己寫爬蟲規則），實作在 custom-rules.js
const customRules = require('./custom-rules');
// safe-fetch.js 提供安全工具：讀取 POST 的 JSON、檢查網址是否為公網、安全地串流請求、內網錯誤類別
const { readJsonBody, assertPublicUrl, safeRequestStream, UnsafeUrlError } = require('./safe-fetch');

// sendJson：統一的 JSON 回應函式。
// 參數：res 回應物件、statusCode HTTP 狀態碼、payload 要回傳的物件。
// 做法：加上 CORS 標頭（允許任何網站呼叫）、設定 Content-Type 為 JSON，再把物件轉成字串送出。
// 一開始檢查 writableEnded 是為了避免已經回應過又重複回應而報錯。
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

// fetchWithTimeout：有「逾時」與「SSRF 防護」的 fetch。
// 參數：url 目標網址、options fetch 選項、timeoutMs 逾時毫秒數（預設 12 秒）。
// 回傳：Response 物件；逾時會被 AbortController 中止並丟出錯誤。
// 為什麼 redirect 要設成 manual：fetch 預設會自動跟著轉址，壞人可以用公網網址轉址到 127.0.0.1 繞過檢查，
// 所以我們自己一跳一跳跟，每一跳都先呼叫 assertPublicUrl 確認不是內網。
// 原生 fetch 封裝（自帶超時防護與 AbortController）
// 轉址改為手動跟隨 (最多 5 次)，每一跳都檢查不是本機 / 內網，避免公網網址 302 到 127.0.0.1 繞過 SSRF 防護
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let current = url;
        for (let hop = 0; hop <= 5; hop++) {
            await assertPublicUrl(current);
            const response = await fetch(current, { ...options, redirect: 'manual', signal: controller.signal });
            const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
            if (!location) return response;
            current = new URL(location, current).toString();
        }
        throw new Error('轉址次數過多');
    } finally {
        clearTimeout(timer);
    }
}

// isUnsafeUrlError：判斷這個錯誤是不是「被內網防護擋下來」的，用來決定回傳 403（禁止）而不是 500。
// 內網阻擋錯誤 (有些爬蟲會把錯誤重新包一層，所以也比對訊息)
function isUnsafeUrlError(err) {
    return err instanceof UnsafeUrlError || /本機或內網|內網位址/.test((err && err.message) || '');
}

// getQueryParam：安全地取得網址 ?key=value 的值並去掉前後空白，沒有就回傳空字串，避免後面出現 null 錯誤。
// 取得 URL 查詢參數安全輔助函數
function getQueryParam(parsedUrl, key) {
    return (parsedUrl.searchParams && parsedUrl.searchParams.get(key)) ? parsedUrl.searchParams.get(key).trim() : '';
}

// 繁體轉簡體的小字典：很多動漫站只收簡體片名，用繁體搜尋會找不到，
// 所以搜尋失敗時用這張表把常見的字換成簡體再試一次（只收常用字，不是完整轉換）。
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

// normalizeAnimeQuery：把搜尋關鍵字「純化」後轉簡體。
// 第一個 replace 去掉開頭的【字幕組】、[字幕組]、(括號) 標記；第二個去掉結尾的「第N話/集」，
// 因為這些會讓搜尋命中率下降。最後逐字用 S2T_MAP 換成簡體。
function normalizeAnimeQuery(str) {
    if (!str) return '';
    const cleaned = str.replace(/^(【[^】]+】|\[[^\]]+\]|\([^\)]+\))\s*/g, '').replace(/第\s*\d+\s*[話集].*$/g, '').trim();
    return cleaned.split('').map(c => S2T_MAP[c] || c).join('');
}

// ==========================================
// KazumiRules 爬蟲引擎 (AGE動漫 & 7sefun)
// ==========================================

// crawlAgeSearch：爬 AGE動漫的搜尋結果頁。
// 參數：keyword 搜尋關鍵字。回傳：[{ title, detailUrl, source:'AGE', cover }]，找不到回傳空陣列。
// 做法：先用原關鍵字，沒結果再用純化後的版本重試。這個站沒有 JSON API，
// 只能抓 HTML 後用正規表示式（regex）挖出標題連結與封面圖。
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

            // 這個 regex 找搜尋結果裡 <h5> 標題內的 <a href="...">片名</a>；[sS]*? 代表「任何字元（含換行）盡量少吃」，
            // 括號 () 是捕獲群組，m[1] 是連結、m[2] 是片名。flags: g 全域、i 不分大小寫。
            const regex = /<h5[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h5>/gi;
            // 另外用一個 regex 抓封面圖（class 含 video_thumbs 的 <img>），之後依順序配對到各筆結果。
            const coverRegex = /<img[^>]+class="[^"]*video_thumbs[^"]*"[^>]+src="([^"]+)"/gi;
            const results = [];
            let m;
            while ((m = regex.exec(html)) !== null) {
                // 站內連結常常是相對路徑（/detail/...），要補上網域變成完整網址。
                const link = m[1].startsWith('http') ? m[1] : `https://www.agedm.io${m[1]}`;
                // 標題裡可能夾雜 HTML 標籤，用 replace 把 <...> 全部刪掉只留文字。
                const title = m[2].replace(/<[^>]+>/g, '').trim();
                results.push({
                    title: title,
                    detailUrl: link,
                    source: 'AGE'
                });
            }

            // 封面與標題是分開抓的，這裡按出現順序一一配對（假設兩者順序一致）。
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

// crawlAgeEpisodes：解析 AGE 詳情頁的集數清單。
// 參數：detailUrl 動漫詳情頁網址。回傳：[{ title, playUrl, line, epIndex }]；頁面讀不到會丟錯。
// 這個站一部動漫有多條播放線路，每條線路都有完整集數，若全部混在一起集數會重複，
// 所以先用 Map 依線路編號分組，同一線路內再用標題 / 集數去重。
// 2. AGE動漫選集解析（依線路分組並去重，防止多線路重疊導致集數重複）
async function crawlAgeEpisodes(detailUrl) {
    const res = await fetchWithTimeout(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error('無法讀取劇集頁面');
    const html = await res.text();

    // 播放連結格式：/play/動漫ID/線路ID/集數ID，這四個捕獲群組分別取出這些資料。
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
        // 為什麼先挑線路 2、3、4：這幾條通常是 m3u8 直連，可以用瀏覽器原生 video 播放（有音量控制）；線路 1 多半是嵌入式播放器。
        // 優先挑選支援原畫直連的線路（Line 2, 3, 4, 5, 6 等通常為 m3u8 直連源，支援原生音量與全功能控制）
        let chosenLine = linesMap.get('2') || linesMap.get('3') || linesMap.get('4') || linesMap.get('1');
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

    // 若上面嚴格格式一個都沒抓到（網站改版了），就改用比較寬鬆的 regex，只要是 /play/ 開頭的連結都收，以免整個壞掉。
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

// crawlAgePlayer：把「某一集的播放頁」解析成真正能播的影片網址。
// 參數：playUrl 單集播放頁網址。回傳：{ playerUrl, isDirectStream }，
//   isDirectStream 為 true 表示是 .m3u8/.mp4 直連（前端可用 video 標籤播），false 表示只是嵌入頁（要用 iframe）。
// 流程（由簡到繁，找到就提早 return）：
//   1) 播放頁的 iframe 網址參數本身就藏著 m3u8/mp4；
//   2) 若是 wuzhoupai 解析器，再去抓那個 iframe 的內容，從 JS 變數 Vurl 挖出真網址；
//   3) 還不行就改試線路 2 的同一集；
//   4) 全部失敗才回傳 iframe 網址當備案。
// 3. AGE動漫播放器真實網址解析 (支援 m3u8/mp4 原生直連萃取)
async function crawlAgePlayer(playUrl) {
    try {
        const res = await fetchWithTimeout(playUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
        }, 8000);
        if (!res.ok) throw new Error('無法讀取播放器頁面');
        const html = await res.text();
        // 找播放器的 <iframe src>：優先找 id 是 iframeForVideo 的，找不到就取頁面第一個 iframe。
        const iframeMatch = html.match(/<iframe[^>]+id="iframeForVideo"[^>]+src="([^"]+)"/i) 
                         || html.match(/<iframe[^>]+src="([^"]+)"/i);
        let url = iframeMatch ? iframeMatch[1] : null;
        if (!url) {
            throw new Error('未能在 AGE 播放頁中解析出播放器網址');
        }

        // 1. 若 URL 參數本身直接包含直連 m3u8/mp4
        // 有些網站把真實影片網址 URL 編碼後放在 ?url= 參數裡，這裡把它撈出來，再 decodeURIComponent 解碼還原。
        const m3u8Match = url.match(/[?&]url=([^&]+\.(?:m3u8|mp4)[^&]*)/i) 
                       || url.match(/(https?%3A%2F%2F[^&]+\.(?:m3u8|mp4)[^&]*)/i);
        if (m3u8Match) {
            const direct = decodeURIComponent(m3u8Match[1]);
            return { playerUrl: direct, isDirectStream: true };
        }

        // 2. 若為 wuzhoupai 解析器（如 /m3u8/?url=age_... 或 /vip/?url=age_...），主動深入解析出真實 m3u8 串流
        if (url.includes('wuzhoupai.com') || url.includes('/m3u8/') || url.includes('/vip/')) {
            try {
                const ifrRes = await fetchWithTimeout(url, {
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.agedm.io/'
                    }
                }, 6000);
                if (ifrRes.ok) {
                    const ifrHtml = await ifrRes.text();
                    const vurlMatch = ifrHtml.match(/var\s+Vurl\s*=\s*['"]([^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i)
                                   || ifrHtml.match(/['"](https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)['"]/i);
                    if (vurlMatch && vurlMatch[1]) {
                        return { playerUrl: vurlMatch[1], isDirectStream: true };
                    }
                }
            } catch (e) {
                console.warn('[AGE wuzhoupai extract warning]:', e.message);
            }

            // 3. 若當前為 Line 1 (vip)，嘗試自動向 Line 2 (m3u8 直連線路) 探針獲取真實串流
            const lineMatch = playUrl.match(/\/play\/(\d+)\/1\/(\d+)/);
            if (lineMatch) {
                try {
                    const altPlayUrl = `https://www.agedm.io/play/${lineMatch[1]}/2/${lineMatch[2]}`;
                    const altRes = await fetchWithTimeout(altPlayUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    }, 5000);
                    if (altRes.ok) {
                        const altHtml = await altRes.text();
                        const altIfrMatch = altHtml.match(/<iframe[^>]+src="([^"]+)"/i);
                        if (altIfrMatch && altIfrMatch[1]) {
                            const altIfrRes = await fetchWithTimeout(altIfrMatch[1], {
                                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.agedm.io/' }
                            }, 5000);
                            if (altIfrRes.ok) {
                                const altIfrHtml = await altIfrRes.text();
                                const altVurl = altIfrHtml.match(/var\s+Vurl\s*=\s*['"]([^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i);
                                if (altVurl && altVurl[1]) {
                                    return { playerUrl: altVurl[1], isDirectStream: true };
                                }
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        return { playerUrl: url, isDirectStream: false };
    } catch (e) {
        throw new Error(e.message || 'AGE動漫播放器解析失敗');
    }
}

// crawl7sefunSearch：爬 7sefun 的搜尋頁（備用來源）。邏輯與 crawlAgeSearch 相同：
// 先原關鍵字、失敗再用純化簡體字重試；回傳 [{ title, cover, detailUrl, source:'7sefun' }]。
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
            // 此站一張卡片就是 <a class="video-wrapper" href=...> 裡面包著 <img src=封面 alt=片名>，一個 regex 同時取出連結、封面、片名。
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

// crawl7sefunEpisodes：解析 7sefun 詳情頁的集數。回傳格式同 crawlAgeEpisodes。
// 播放連結長這樣：/vodplay/動漫ID-線路ID-集數.html，同樣依線路分組去重後選一條線路。
// 5. 7sefun選集解析（依播放線路分組並優先選取具備原生直連的 Line 2）
async function crawl7sefunEpisodes(detailUrl) {
    const res = await fetchWithTimeout(detailUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error('無法讀取 7sefun 劇集頁面');
    const html = await res.text();

    // 四個捕獲群組：完整路徑、動漫ID、線路ID、集數；m[5] 是連結內的文字（集數名稱）。
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
        // 優先線路 2（有原生 mp4），否則線路 1，再不行就選集數最多的那條。
        // 優先選取具備原生直連 .mp4 的 Line 2 (ndx)，若無則依序選取 Line 1 或集數最多的線路
        let chosen = linesMap.get('2') || linesMap.get('1');
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

    // 嚴格格式沒抓到時的備案：只要是 /vodplay/ 開頭的連結都收，用標題去重。
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

// resolveDpNo3acgStream：7sefun 的播放器把真實影片網址用 AES 加密藏在頁面裡，這裡負責解密。
// 參數：realUrl 播放頁拿到的原始網址、from 播放器代號。
// 回傳：{ playerUrl, isDirectStream, isBlockedIframe }；解不開就回傳播放器頁本身當降級。
// 流程：抓播放器頁 -> 用 regex 挖出 JS 變數 ConFig（JSON）-> 以 uid 組成金鑰 -> AES-128-CBC 解密 -> 得到真實 mp4/m3u8。
// 注意：金鑰與 IV 是對方網站前端程式碼裡公開寫死的規則，我們只是照著它的演算法還原，不是破解別人的密碼。
// 2.5 解析並解密 7sefun 的 dp.no3acg.com AES 加密串流，取得原生直連 .mp4 / .m3u8 避免黑屏與第三方控制項干擾
async function resolveDpNo3acgStream(realUrl, from = 'lmm') {
    const dpUrl = `https://dp.no3acg.com/player/ec.php?code=qw&if=1&from=${from}&url=${encodeURIComponent(realUrl)}`;
    try {
        const res = await fetchWithTimeout(dpUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://www.7sefun.top/'
            }
        }, 8000);
        if (res.ok) {
            const html = await res.text();
            // 取出頁面中 `let ConFig = {...}, box` 這段 JSON 字串（非貪婪比對到 ", box" 為止）。
            const configMatch = html.match(/let\s+ConFig\s*=\s*(\{[\s\S]*?\})\s*,\s*box/);
            if (configMatch) {
                const configObj = JSON.parse(configMatch[1]);
                if (configObj.code === 200 && configObj.url && configObj.config && configObj.config.uid) {
                    const crypto = require('crypto');
                    // 金鑰 = 固定前綴 + 使用者 uid + 固定後綴；IV（初始向量）是固定值。CBC 模式的解密需要這兩個。
                    const key = Buffer.from('2890' + configObj.config.uid + 'tB959C', 'utf8');
                    const iv = Buffer.from('2F131BE91247866E', 'utf8');
                    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                    // 密文是 base64 編碼，解密後得到 UTF-8 字串；final() 補完最後一個區塊。
                    let decrypted = decipher.update(configObj.url, 'base64', 'utf8');
                    decrypted += decipher.final('utf8');
                    if (decrypted && (decrypted.startsWith('http://') || decrypted.startsWith('https://'))) {
                        return { playerUrl: decrypted, isDirectStream: true, isBlockedIframe: false };
                    }
                }
            }
        }
    } catch (e) {
        // 例外一律吞掉：解密失敗不應該讓整個播放壞掉，下面會回傳外部播放器網址當備案。
        // 優雅降級：若超時或線路異常，不阻斷主線路，平滑回退為外部解析播放器
    }
    return { playerUrl: dpUrl, isBlockedIframe: false, isDirectStream: false };
}

// crawl7sefunPlayer：解析 7sefun 單集播放頁，找出最適合的播放網址。
// 參數：playUrl 單集播放頁。回傳：{ playerUrl, isDirectStream, isBlockedIframe }。
//   isBlockedIframe 為 true 代表該播放器(lmm85.com)禁止被嵌入別人網頁(X-Frame-Options SAMEORIGIN)，前端要顯示替代提示。
// 這個站用 MacCMS 系統，頁面裡有一個 player_aaaa 的 JSON 變數，其中 url 可能被加密：encrypt=1 用 unescape，encrypt=2 用 base64。
// 取得 realUrl 後依優先順序嘗試：直連 mp4/m3u8 -> AES 解密 -> 特定播放器適配器 -> 備援線路 -> 標記為被阻擋。
// 6. 7sefun動漫播放器真實網址解析 (支援 dp.no3acg.com AES 解密、原生 .m3u8/.mp4 直出與跨線路容錯)
async function crawl7sefunPlayer(playUrl) {
    try {
        const res = await fetchWithTimeout(playUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }
        });
        if (!res.ok) return { playerUrl: playUrl };
        const html = await res.text();

        // 嘗試解析 MacCMS 的 player_aaaa JSON 變數
        // 取出頁面內 `player_aaaa = {...}</script>` 這段 JSON。
        const aaaaMatch = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})<\/script>/);
        if (aaaaMatch) {
            try {
                const parsed = JSON.parse(aaaaMatch[1].trim());
                let realUrl = parsed.url;
                // 解碼網址：encrypt 2 = base64 再 URL 解碼；encrypt 1 = escape 編碼。
                if (parsed.encrypt === 2) {
                    realUrl = decodeURIComponent(Buffer.from(parsed.url, 'base64').toString('utf-8'));
                } else if (parsed.encrypt === 1) {
                    realUrl = unescape(parsed.url);
                }

                if (realUrl) {
                    // 1. 若本身即為 .mp4 / .m3u8 原生直連串流或內嵌串流網址，直接返回（走原生 video 標籤，不黑屏且音量完全受控）
                    const directMatch = realUrl.match(/https?%3A%2F%2F[^\s&"']+\.(?:m3u8|mp4)[^\s&"']*/i) || realUrl.match(/https?:\/\/[^\s&"']+\.(?:m3u8|mp4)[^\s&"']*/i);
                    if (directMatch) {
                        const rawDirect = decodeURIComponent(directMatch[0]);
                        return { playerUrl: rawDirect, isDirectStream: true, isBlockedIframe: false };
                    }
                    if (/\.(mp4|m3u8)(\?.*)?$/i.test(realUrl) || realUrl.includes('.mp4') || realUrl.includes('.m3u8')) {
                        return { playerUrl: realUrl, isDirectStream: true, isBlockedIframe: false };
                    }

                    // 2. 優先嘗試透過 7sefun 官方適配器 dp.no3acg.com AES 解密取得原生直連串流
                    const streamResult = await resolveDpNo3acgStream(realUrl, parsed.from || 'lmm');
                    if (streamResult && streamResult.isDirectStream) {
                        return streamResult;
                    }

                    // 3. 若為其他播放器適配器規則（若 realUrl 不含直連副檔名才轉發解析器）
                    if (parsed.from === 'ndx' || parsed.from === 'aafun2' || parsed.from === 'CYDD1') {
                        if (realUrl.startsWith('http') && (realUrl.includes('.mp4') || realUrl.includes('.m3u8'))) {
                            return { playerUrl: realUrl, isDirectStream: true, isBlockedIframe: false };
                        }
                        const addonUrl = `https://www.7sefun.top/addons/dp/player/index.php?key=0&id=${parsed.id || 0}&uid=0&from=${parsed.from}&url=${encodeURIComponent(realUrl)}`;
                        return { playerUrl: addonUrl, isBlockedIframe: false, isDirectStream: false };
                    }

                    if (streamResult && !streamResult.isBlockedIframe && streamResult.playerUrl && !streamResult.playerUrl.includes('lmm85.com')) {
                        return streamResult;
                    }

                    // 這條線路被擋時，換成「另一條線路的同一集」再試一次：線路1 與 2 互換。
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

                    return { playerUrl: (streamResult && streamResult.playerUrl) ? streamResult.playerUrl : realUrl, isBlockedIframe: false };
                }
            } catch (e) {
                console.warn('[7sefun Parse player_aaaa error]:', e.message);
            }
        }

        // player_aaaa 找不到時的最後備案：直接用頁面的第一個 iframe。
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

// Girigirilove 與前兩個站不同：它提供正式的 JSON API，所以不用 regex 爬 HTML，資料更穩定。
// 5. Girigirilove (ani.girigirilove.com) 官方高速 JSON API 資源搜尋與 m3u8 直出串流模組
// toSimplifiedAnimeTitle：繁體轉簡體（比 S2T_MAP 多一些字），專給 Giri 搜尋不到時回退使用。
function toSimplifiedAnimeTitle(str) {
    if (!str) return '';
    const map = {
        '圓': '圆', '偵': '侦', '戰': '战', '鬥': '斗', '機': '机', '隊': '队', 
        '劇': '剧', '場': '场', '傳': '传', '說': '说', '異': '异', '轉': '转', 
        '戀': '恋', '愛': '爱', '結': '结', '術': '术', '迴': '回', '斬': '斩', '終': '终', 
        '殺': '杀', '龍': '龙', '貓': '猫', '網': '网', '點': '点', '鋼': '钢', '鍊': '炼', 
        '櫻': '樱', '衛': '卫', '靈': '灵', '國': '国', '變': '变', '實': '实', '錄': '录',
        '誌': '志', '學': '学', '園': '园', '風': '风', '門': '门', '開': '开', '關': '关',
        '電': '电', '視': '视', '聽': '听', '話': '话', '語': '语', '進': '进', '擊': '击',
        '滅': '灭', '寶': '宝', '夢': '梦', '線': '线', '發': '发', '現': '现', '動': '动'
    };
    return str.split('').map(c => map[c] || c).join('');
}

// crawlGiriSearch：呼叫 Girigiri 的 get_list API 搜尋動漫。回傳 [{ title, detailUrl, cover, remarks, year, source:'Giri' }]；任何錯誤都回傳空陣列。
async function crawlGiriSearch(keyword) {
    try {
        // fetchRows：內部小函式，送出搜尋並從 JSON 取出清單。因為 API 回傳格式可能不同(info.rows / data.rows / list)，三種都支援。
        let fetchRows = async (kw) => {
            const url = `https://m3u8.girigirilove.com/api.php/Vod/get_list?vod_name=${encodeURIComponent(kw)}&limit=24`;
            const res = await fetchWithTimeout(url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Referer': 'https://ani.girigirilove.com/',
                    'Accept': 'application/json'
                }
            }, 8000);
            if (!res.ok) return [];
            const json = await res.json();
            return (json.info && Array.isArray(json.info.rows)) ? json.info.rows : 
                   (json.data && Array.isArray(json.data.rows)) ? json.data.rows : 
                   (Array.isArray(json.list) ? json.list : []);
        };

        let rows = await fetchRows(keyword);
        // 繁體搜不到就換簡體再搜一次。
        // 若繁體查詢無結果，自動嘗試簡化標題回退查詢（例如「小圓」->「小圆」）
        if (rows.length === 0) {
            const simpKw = toSimplifiedAnimeTitle(keyword);
            if (simpKw && simpKw !== keyword) {
                rows = await fetchRows(simpKw);
            }
        }
        
        return rows.map(item => ({
            title: item.vod_name || item.name || '未命名番劇',
            detailUrl: `https://m3u8.girigirilove.com/api.php/Vod/get_detail?vod_id=${item.vod_id || item.id}`,
            cover: item.vod_pic || item.pic || 'https://ani.girigirilove.com/brand/icon.png',
            remarks: item.vod_remarks || '',
            year: item.vod_year || '',
            source: 'Giri'
        }));
    } catch (e) {
        console.warn('[Giri Search failed]:', e.message);
        return [];
    }
}

// crawlGiriEpisodes：取得 Girigiri 動漫的集數。參數 detailUrl 可以是完整 API 網址或純數字 vod_id。
// API 把多條線路用 "$$$" 隔開，同一線路的各集用 "#" 隔開，每集是「集名$播放網址」，所以要三層 split 拆開，
// 並在標題前加上 [繁中]/[簡中] 之類的線路標籤。
async function crawlGiriEpisodes(detailUrl) {
    try {
        let url = detailUrl;
        if (/^\d+$/.test(detailUrl)) {
            url = `https://m3u8.girigirilove.com/api.php/Vod/get_detail?vod_id=${detailUrl}`;
        }
        const res = await fetchWithTimeout(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://ani.girigirilove.com/',
                'Accept': 'application/json'
            }
        }, 8000);
        if (!res.ok) return [];
        const json = await res.json();
        const info = json.info || json.data || {};
        const playFrom = (info.vod_play_from || '').split('$$$');
        const playUrlGroups = (info.vod_play_url || '').split('$$$');
        const episodes = [];

        for (let g = 0; g < playUrlGroups.length; g++) {
            const rawFrom = playFrom[g] || `線路${g + 1}`;
            const sourceLabel = rawFrom.toLowerCase() === 'cht' ? '繁中' : (rawFrom.toLowerCase() === 'chs' ? '簡中' : rawFrom);
            const epList = playUrlGroups[g].split('#').filter(Boolean);
            for (const ep of epList) {
                const parts = ep.split('$');
                const epTitle = parts[0] ? parts[0].trim() : `第${episodes.length + 1}話`;
                const epUrl = parts[1] ? parts[1].trim() : parts[0];
                if (epUrl) {
                    const fullTitle = `[${sourceLabel}] ${epTitle}`;
                    episodes.push({
                        title: fullTitle,
                        name: fullTitle,
                        playUrl: epUrl,
                        line: sourceLabel,
                        epIndex: episodes.length + 1
                    });
                }
            }
        }
        return episodes;
    } catch (e) {
        console.warn('[Giri Episodes failed]:', e.message);
        return [];
    }
}

// fetchDandanplayDanmaku：向彈彈play（dandanplay）開放平台取得彈幕。
// 參數：animeTitle 片名、episodeIndex 第幾集、appId / appSecret 開發者金鑰（可由前端傳入或讀環境變數）。
// 回傳：[{ time, color, content }] 最多 150 筆；沒金鑰、搜不到或出錯一律回傳 null（呼叫端會改走其他來源）。
// 認證方式：簽章 = SHA256(AppId + 時間戳 + API路徑 + AppSecret) 再轉 base64，放在 X-Signature 標頭，secret 本身不會被送出。
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

        // 找出正確的那一集：先比集數數字，再比標題含「第N」，再比兩位數字。只有第 1 集允許退回第一筆，其他集找不到就放棄，避免彈幕對錯集。
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

        // 第二步用 episodeId 取彈幕，withRelated=true 會順便合併其他平台的彈幕，chConvert=1 轉成繁體。
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

        // 彈幕的 p 欄位格式是「時間,模式,顏色,使用者」，用逗號拆開；顏色是十進位整數，轉成 #RRGGBB 十六進位字串，預設白色。
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

// ===== 以下是路由總入口 =====
// handleKazumiRoute：所有 /api/kazumi/* 請求都先進來這裡，再依 pathname（網址路徑）用 if / else if 分派到對應的處理區塊。
// 沒有回傳值，結果都是直接寫進 res；每個分支用 return sendJson(...) 結束。
// 最外層有 try/catch，任何沒預期到的錯誤都會變成 500 回應，避免伺服器崩潰。
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

        // 瀏覽器跨網域呼叫前會先送 OPTIONS「預檢」詢問是否允許，這裡直接回 204（成功但沒內容）並帶上允許的標頭。
        // 1. CORS OPTIONS 預檢請求
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
            res.statusCode = 204;
            res.end();
            return;
        }

        // 路由 A：GET /api/kazumi/search?q=關鍵字
        // 請求：query 參數 q（必填）。成功回應：{ success:true, count, results:[{ id, title, title_cn, cover, rating, eps, summary }] }。
        // 錯誤：缺 q 回 400；Bangumi 連不上回 502；其他例外回 500。type=2 代表只搜「動畫」類型。
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
                
                // 把 Bangumi 原始資料挑出前端需要的欄位並補預設值（沒簡介就顯示「暫無簡介」，評分取到小數第 1 位）。
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

        // 路由 B：GET /api/kazumi/resolve?bvid=BV號 或 ?url=網址
        // 用途：把使用者貼的連結整理成統一的 data 格式給劇院播放。三種結果：
        //   1) 含 Bilibili BV 號 -> 查分P清單(pagelist)與影片資訊(view)，回傳 type:'bilibili'；
        //   2) 一般 http(s) 網址 -> 直接當外部串流，附上 stream-proxy 代理網址，回傳 type:'stream'；
        //   3) 都不是 -> 400。
        // 3. 路由 B: 影片/動漫來源解析 /api/kazumi/resolve?bvid={bvid}&url={url}
        else if (pathname === '/api/kazumi/resolve') {
            const bvid = getQueryParam(parsedUrl, 'bvid');
            const url = getQueryParam(parsedUrl, 'url');

            // BV 號固定是「BV」加 10 個英數字，用 regex 從網址或參數中抓出來。
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

                    // 分P清單：Bilibili 一支影片可以有多個分P（page），每個有自己的 cid（彈幕與播放用的編號）。
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

                    // 先放預設值，下面的影片資訊查詢失敗時（例如逾時）頁面仍有東西可顯示，不會整個壞掉。
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
                    // 影片資訊只是加分資料，查不到就沿用預設值，所以錯誤直接忽略。
                    } catch (e) {}

                    // 連分P清單都拿不到時，至少塞一集假資料，讓前端還能嘗試播放。
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
            // 非 Bilibili 的一般網址：不去抓內容，只包裝成統一格式；實際播放時前端會透過 proxyUrl 走下方的串流代理。
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

        // 路由 B-2：GET /api/kazumi/bilibili-playurl?bvid=&cid=&url=
        // 用途：取得 Bilibili 影片「真正的 MP4 直連網址」，這樣前端可以用原生 video 標籤播放（支援音量、拖曳）。
        // 成功回應：{ success:true, isDirectStream:true, streamUrl(經代理), rawUrl, bvid, cid, duration, size }。
        // 失敗不回錯誤，而是回 isDirectStream:false 加上 fallbackIframeUrl（B站官方嵌入播放器），讓前端降級使用 iframe。
        // 流程：從參數或網址挖出 bvid / 番劇 ss / ep 編號 -> 番劇需先用 pgc 介面反查 bvid 與 cid -> 沒有 cid 就查 pagelist ->
        //       依序試一般 UGC 介面與番劇 PGC 介面取得 durl（直連清單）。
        // 3.1 路由 B-2: 解析 Bilibili 真實直連 MP4 串流 /api/kazumi/bilibili-playurl?bvid={bvid}&cid={cid}&url={url}
        else if (pathname === '/api/kazumi/bilibili-playurl') {
            let bvid = getQueryParam(parsedUrl, 'bvid') || '';
            let cid = getQueryParam(parsedUrl, 'cid') || '';
            const rawUrl = getQueryParam(parsedUrl, 'url') || '';

            // 從傳入的網址或參數中智能萃取 bvid、season_id 或 ep_id
            // ss = season_id（整季）、ep = ep_id（單集），是 Bilibili 番劇網址的兩種格式；用 regex 兼容網址與 query 參數兩種寫法。
            const searchTarget = rawUrl || bvid;
            const bvMatch = searchTarget.match(/(BV[a-zA-Z0-9]{10})/i);
            const ssMatch = searchTarget.match(/bangumi\/play\/ss(\d+)/i) || searchTarget.match(/season_id=(\d+)/i);
            const epMatch = searchTarget.match(/bangumi\/play\/ep(\d+)/i) || searchTarget.match(/ep_id=(\d+)/i);

            if (bvMatch) {
                bvid = bvMatch[1];
            }

            try {
                // 番劇網址沒有 BV 號，要先問官方 pgc 介面該季的集數清單，找出對應集的 bvid 與 cid。
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

                // 沒給 cid（或為 0）時，用 pagelist 取第一個分P的 cid。
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
                    // qn=64 是 720P 畫質；fnval=0 + platform=html5 要求回傳單一 MP4（durl）而非分離的音視訊串流，瀏覽器才能直接播。
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
                            // B站影片有防盜鏈（要帶 Referer），瀏覽器直連會 403，所以回傳我們自己的 stream-proxy 網址，讓伺服器代為抓取。
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

                    // 一般介面拿不到時改用番劇專用介面；?. 是選擇性鏈結，避免中間欄位不存在時報錯。
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

        // 路由 C：GET /api/kazumi/danmaku?cid=&anime=&ep=&source=&appId=&appSecret=
        // 回傳：{ success:true, source, count, danmaku:[{ time(秒), color(#RRGGBB), content }] }；找不到就回傳空陣列（不造假彈幕）。
        // 取得順序：A. 使用者選彈彈play 且有金鑰 -> 用彈彈play；B. 沒有 cid 但有片名 -> 去 Bilibili 搜尋該集影片反查 cid；
        //           C. 有 cid -> 抓 Bilibili 官方即時彈幕 XML；D. 都失敗 -> 空陣列。
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

            // 反查邏輯：同一部動漫在 B站有很多二創與整理影片，必須用「第N話」比對，並排除雜訊，才能找到正確的那一集。
            // B. 若無 cid 但有片名（或使用者選擇 Bilibili 官方直連），依集數獨立檢索各集彈幕最多之真實 CID
            if (!cid && anime) {
                try {
                    // 淨化片名 (去除集數、季數與多餘標點)
                    // 清理片名：移除括號符號、「第N集」與 Season/S2 這類字樣，只留核心片名。
                    const cleanKeyword = anime
                        .replace(/[【】\[\]()（）]/g, ' ')
                        .replace(/第\s*\d+\s*[集話期]/g, '')
                        .replace(/(Season\s*\d+|S\d+)/gi, '')
                        .trim();

                    const epPad = String(epNum).padStart(2, '0');
                    // epRegex：用集數動態組出的 regex，可比對「第3話」「EP3」「3集」「03」等寫法（i 不分大小寫）；noiseRegex 用來排除導視、reaction、OST 等非正片。
                    const epRegex = new RegExp(`(?:第\\s*(?:0?${epNum})\\s*[話集期]|ep\\s*(?:0?${epNum})\\b|\\b0?${epNum}\\s*[話集]|\\bEP${epNum}\\b|\\b${epPad}\\b)`, 'i');
                    const noiseRegex = /(导视|吐槽|漫谈|手办|联动|第五人格|reaction|原声带|OST|纯音乐|二创|解说)/i;

                    // 多種寫法各搜一次，直到湊滿 6 個候選為止；order=dm 代表依彈幕數排序，彈幕最多的通常是正片。
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
                    // 排序後，下面會從彈幕最多的候選開始嘗試，成功取得 cid 就 break。
                    matchedCandidates.sort((a, b) => b.danmaku - a.danmaku);

                    // pagelist 回傳該影片所有分P：若是合集就依集數取第 N 個分P；若是單集影片則要求標題明確寫著該集。
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

                    // 備案：直接用片名搜尋「全集合集」影片，最多檢查前 8 筆；合集的分P數必須 >= 集數才合理。
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
                // 反查失敗不影響主流程，只記 log，後面仍會回傳空彈幕。
                } catch (bSearchErr) {
                    console.log('[Kazumi Danmaku] B站分集 CID 動態反查略過:', bSearchErr.message);
                }
            }

            // Bilibili 彈幕是 XML：<d p="時間,模式,字級,顏色,...">內容</d>，用 regex 逐筆取出，p 的第 1 欄是時間、第 4 欄是顏色。
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
                        // 注意 [^<]+ 表示內容不含 "<"，所以含特殊字元的彈幕可能被略過，這是可接受的簡化。
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

        // 路由 D：GET /api/kazumi/stream-proxy?url=編碼後的網址
        // 用途：串流代理。瀏覽器直接播第三方影片會遇到 CORS 或防盜鏈（Referer 檢查），由伺服器去拿再轉送給瀏覽器。
        // 重點：支援 Range 標頭（拖曳時間軸需要分段下載）、用 pipe 邊下載邊轉送、客戶端中斷時要銷毀上游連線以免浪費流量。
        // 錯誤：缺參數或網址無效 400；打到內網 403；上游失敗 502。
        // 5. 路由 D: 串流與防盜鏈代理 /api/kazumi/stream-proxy?url={encodedUrl}
        else if (pathname === '/api/kazumi/stream-proxy') {
            const rawUrl = getQueryParam(parsedUrl, 'url');
            if (!rawUrl) {
                return sendJson(res, 400, { success: false, error: '缺少目標串流網址參數 "url"' });
            }

            // 前端可能多編碼一次，所以這裡 decodeURIComponent 再解一次，並用 new URL 驗證格式，且只接受 http / https。
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
            // 這是最重要的安全檢查：代理若不設限，別人可以拿它掃描我們的內網（SSRF）。
            // 代理不可被拿來打本機 / 內網：用 safeRequestStream，每一跳轉址都重新檢查，
            // 連線時再檢查 DNS 結果 (防 DNS rebinding)；fetch 預設自動跟轉址會繞過檢查，所以不用 fetch
            // 針對 Bilibili 相關網域補上 Referer 標頭，騙過防盜鏈（這些 CDN 只認 bilibili.com 來源）。
            const isBilibiliHost = (h) => h.includes('bilibili') || h.includes('hdslb') || h.includes('akamaized.net') || h.includes('bilivideo');
            const headersFor = (u) => {
                const h = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': '*/*'
                };
                if (req.headers.range) h['Range'] = req.headers.range;
                if (isBilibiliHost(u.hostname)) h['Referer'] = 'https://www.bilibili.com/';
                return h;
            };

            // 清理機制：只要使用者關掉頁面、換集或拖曳導致連線中斷，就把上游請求也一併銷毀，避免資源洩漏。isAborted 防止重複清理。
            let upstreamReq = null;
            let isAborted = false;
            const cleanupStream = () => {
                if (isAborted) return;
                isAborted = true;
                try { if (upstreamReq) upstreamReq.destroy(); } catch (e) {}
            };
            req.on('close', cleanupStream);
            res.on('close', cleanupStream);

            try {
                const { upstream, request } = await safeRequestStream(targetUrl, { headersFor });
                upstreamReq = request;
                if (isAborted) { request.destroy(); return; }

                res.statusCode = upstream.statusCode || 502;
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Headers', 'Range');
                res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

                // 只轉送必要的回應標頭給瀏覽器（類型、長度、Range 資訊等），其餘不傳，避免洩漏或衝突。
                const headersToPass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'content-encoding'];
                for (const h of headersToPass) {
                    const val = upstream.headers[h];
                    if (val) res.setHeader(h, val);
                }

                // 這裡很重要：串流中斷會觸發 error 事件，若沒有監聽，Node.js 會把它當成未處理例外而讓整個伺服器掛掉。
                // 客戶端中斷、換源、拖曳時間軸產生的 ECONNRESET 屬於正常中斷，靜默處理避免 unhandled 'error' 讓伺服器崩潰
                upstream.on('error', () => {
                    if (!res.writableEnded) { try { res.end(); } catch (e) {} }
                });
                res.on('error', () => cleanupStream());

                upstream.pipe(res);
            } catch (err) {
                if (isAborted) return;
                if (err instanceof UnsafeUrlError) {
                    return sendJson(res, 403, { success: false, error: err.message });
                }
                console.error('[Kazumi Stream Proxy Error]:', err.message);
                if (!res.headersSent) {
                    sendJson(res, 502, { success: false, error: '串流代理傳輸失敗：' + err.message });
                }
            }
        }

        // 路由 E：GET /api/kazumi/rules，回傳前端可選的爬蟲來源清單（固定寫死的靜態資料，前端用來畫下拉選單）。
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

        // 路由 F：GET /api/kazumi/rule-search?q=&source=（source 預設 AGE，可選 Giri、7sefun）
        // 依 source 呼叫上方對應的爬蟲函式；回傳 { success, source, count, results }。缺 q 回 400。
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

        // 路由 G：GET /api/kazumi/rule-episodes?detailUrl=詳情頁網址
        // 依網址特徵判斷是哪個站，呼叫對應的集數解析函式。回傳 { success, count, episodes }。
        // 安全：先 assertPublicUrl 擋內網（403）；爬蟲過程中若又被擋也轉成 403，其他錯誤 500。
        // 8. 路由 G: 取得指定動漫的全部選集 /api/kazumi/rule-episodes?detailUrl={detailUrl}
        else if (pathname === '/api/kazumi/rule-episodes') {
            const detailUrl = getQueryParam(parsedUrl, 'detailUrl');
            if (!detailUrl) {
                return sendJson(res, 400, { success: false, error: '缺少 detailUrl 參數' });
            }
            try { await assertPublicUrl(detailUrl); } catch (e) { return sendJson(res, 403, { success: false, error: e.message }); }

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
                return sendJson(res, isUnsafeUrlError(err) ? 403 : 500, { success: false, error: '取得選集失敗：' + err.message });
            }
        }

        // 路由 H：GET /api/kazumi/rule-play?playUrl=單集播放頁網址
        // 依網址判斷來源 -> 呼叫對應播放器解析 -> 回傳 { success, playerUrl, isBlockedIframe, isDirectStream }。
        // 已經是 .m3u8 / .mp4 的網址就直接當成直連串流；找不到播放器網址回 404。同樣先做內網檢查。
        // 9. 路由 H: 解析單集播放器網址 /api/kazumi/rule-play?playUrl={playUrl}
        else if (pathname === '/api/kazumi/rule-play') {
            const playUrl = getQueryParam(parsedUrl, 'playUrl');
            if (!playUrl) {
                return sendJson(res, 400, { success: false, error: '缺少 playUrl 參數' });
            }
            try { await assertPublicUrl(playUrl); } catch (e) { return sendJson(res, 403, { success: false, error: e.message }); }

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
                return sendJson(res, isUnsafeUrlError(err) ? 403 : 500, { success: false, error: '解析播放器失敗：' + err.message });
            }
        }

        // 路由 I：POST /api/kazumi/custom-search | custom-episodes | custom-play
        // 使用者自己提供爬蟲規則（rule），實際爬取由 custom-rules.js 執行；網址最後一段（search / episodes / play）決定動作。
        // 請求 body（JSON）：{ rule, q 或 detailUrl 或 playUrl }。非 POST 回 405；動作不認得 404；打到內網 403；其他失敗 502。
        // 10. 使用者自訂 Kazumi 規則 (POST，body 帶 { rule, q | detailUrl | playUrl })
        else if (pathname.startsWith('/api/kazumi/custom-')) {
            if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: '請使用 POST' });
            const action = pathname.slice('/api/kazumi/custom-'.length);
            try {
                const body = await readJsonBody(req);
                if (action === 'search') {
                    const q = String(body.q || '').trim();
                    if (!q) return sendJson(res, 400, { success: false, error: '請提供搜尋關鍵字 "q"' });
                    const { results, matched } = await customRules.animeSearch(body.rule, q);
                    return sendJson(res, 200, { success: true, source: body.rule && body.rule.name, count: results.length, matched, results });
                }
                if (action === 'episodes') {
                    const episodes = await customRules.animeEpisodes(body.rule, String(body.detailUrl || ''));
                    return sendJson(res, 200, { success: true, count: episodes.length, episodes });
                }
                if (action === 'play') {
                    const result = await customRules.animePlay(body.rule, String(body.playUrl || ''));
                    return sendJson(res, 200, { success: true, ...result });
                }
                return sendJson(res, 404, { success: false, error: '未知的自訂規則操作' });
            } catch (err) {
                return sendJson(res, err instanceof UnsafeUrlError ? 403 : 502, { success: false, error: err.message });
            }
        }

        // 其他沒有定義的路徑一律回 404，並把路徑回傳方便除錯。
        // 11. 未知 Kazumi 路由
        else {
            sendJson(res, 404, { success: false, error: '找不到該 Kazumi API 路由: ' + pathname });
        }
    // 最外層保險：所有分支沒接住的錯誤都在這裡轉成 500 JSON，不讓錯誤直接炸掉伺服器。
    } catch (globalErr) {
        console.error('[Kazumi Global Error]:', globalErr);
        sendJson(res, 500, { success: false, error: '伺服器內部發生異常：' + globalErr.message });
    }
}

module.exports = { handleKazumiRoute };
