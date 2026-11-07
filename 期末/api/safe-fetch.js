// 【總說明】api/safe-fetch.js：「安全的對外抓網頁」工具，被 custom-rules / novel / manga / kazumi 等模組使用。
// 為什麼需要？自訂規則讓使用者填「任意網址」，伺服器會幫他去抓。如果不檢查，壞人可以填
// http://localhost:8090/... 或 http://192.168.x.x/ 或雲端的 169.254.169.254，叫伺服器去讀「只有內部才連得到」的資料，
// 這種攻擊叫 SSRF（伺服器端請求偽造）。所以這裡做了多層防護：
//  1. assertUrlShape：先檢查網址格式（只許 http/https、不可含帳密、不可是 localhost/內網主機名）
//  2. isPrivateIp：判斷 IP 是否屬於內網 / 保留位址
//  3. safeLookup：在「連線當下」才解析 DNS 並檢查 IP（防 DNS rebinding：第一次查給公網 IP 通過檢查，連線時卻換成內網 IP）
//  4. 限制逾時、回應大小、轉址次數；每次轉址都重新檢查
// 匯出：safeFetchText（抓文字）、safeRequestStream（串流）、readJsonBody（讀 POST JSON）等。
/**
 * Web Library - 安全對外抓取 (使用者自訂規則專用)
 * 自訂規則可以填任意網址，所以抓取前必須擋掉 localhost / 內網 / 保留位址 (SSRF)，
 * 並限制逾時、回應大小與轉址次數。
 * DNS 解析結果在連線當下 (socket lookup) 檢查，避免「先查公網 IP、連線時換成內網 IP」的 DNS rebinding。
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

// 預設 User-Agent，偽裝成一般 Chrome 瀏覽器，避免被部分網站當成機器人擋掉。
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 這些結尾的主機名稱通常是內網專用，直接拒絕。
const BLOCKED_HOST_SUFFIX = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet'];

// ipv4ToInt(ip)：把 "192.168.1.1" 轉成一個大整數（每段當 256 進位），方便做網段比較。
function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, p) => (acc * 256) + Number(p), 0);
}

// 不能連的 IPv4 網段表，格式 [網段起點, 遮罩位數]。例如 ['10.0.0.0', 8] 代表 10.x.x.x 全部；
// 127=本機、172.16/12 與 192.168/16=私有網路、169.254=link-local（雲端 metadata 位址就在這）、224 以上=多播/保留。
// .map 先把起點轉成整數備用。
const PRIVATE_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => [ipv4ToInt(base), bits]);

// isPrivateIp(ip)：判斷是否為「不該連」的位址。參數 ip 字串；回傳 true=危險（內網/保留）、false=公網。
// IPv4：把 ip 與網段各自除以 2^(32-遮罩) 取整數後比較——前面「網路部分」相同就代表在該網段內。
// （用除法加 Math.floor 取代位元運算，是因為 JS 位元運算是 32 位有號數，會有負數問題。）
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const n = ipv4ToInt(ip);
        return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
    }
    // IPv6：擋 ::、::1(本機)、::ffff:x.x.x.x(IPv4 包在 IPv6 裡的寫法，要拿出 v4 再檢查，否則可繞過)、
    // fc00::/7(私有)、fe80::/10(本地連結)、ff00::/8(多播)、文件與轉換用保留位址。
    // 用 first & 遮罩 比對前綴位元。
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        if (v === '::' || v === '::1') return true;
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateIp(mapped[1]);
        if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true; // 十六進位寫法的 v4-mapped，一律擋
        const first = parseInt(v.split(':')[0] || '0', 16);
        if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
        if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
        if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
        if (v.startsWith('64:ff9b:') || v.startsWith('2001:db8:')) return true;
        return false;
    }
    // 保守原則：看不懂的一律當不安全。
    return true; // 不是合法 IP 一律視為不安全
}

// 自訂錯誤類別：被安全檢查擋下時丟這種錯，呼叫端可用 instanceof 判斷是「被阻擋」而不是一般網路錯誤。
class UnsafeUrlError extends Error {}

// assertUrlShape(urlStr)：檢查字串網址是否安全。通過回傳 URL 物件，不通過丟 UnsafeUrlError。
// 這一步只看「字面」；主機名稱若是網域（非 IP），真正解析出的 IP 要到 safeLookup 才檢查。
// 注意第 57 行條件：沒有 "." 且不是 IP 的主機名（如 intranet、router）視為內網名稱而擋掉。
// 檢查網址格式與主機名稱 (IP 實際檢查在 safeLookup 連線時做)
function assertUrlShape(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch (e) { throw new UnsafeUrlError('網址格式無效'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('只允許 http / https 網址');
    if (u.username || u.password) throw new UnsafeUrlError('網址不可包含帳號密碼');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || BLOCKED_HOST_SUFFIX.some(s => host.endsWith(s)) || !host.includes('.') && !net.isIP(host)) {
        throw new UnsafeUrlError('不允許連線到本機或內網位址');
    }
    if (net.isIP(host) && isPrivateIp(host)) throw new UnsafeUrlError('不允許連線到本機或內網位址');
    return u;
}

// safeLookup(hostname, options, callback)：自訂的 DNS 查詢函式，傳給 http.request 的 lookup 選項。
// Node 連線前會呼叫它把網域換成 IP；這裡把「所有」解析結果都檢查一遍，只要有一個是內網就拒絕。
// 因為檢查與連線用的是同一次解析結果，攻擊者無法在兩者之間偷換 IP（防 DNS rebinding）。
// options.all 為真時 Node 要的是位址陣列，否則是單一位址與 family。
// 給 http.request 用的 lookup：解析出的每個位址都必須是公網
function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addrs) => {
        if (err) return callback(err);
        if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
            return callback(new UnsafeUrlError('目標主機解析到內網位址，已阻擋'));
        }
        if (options.all) return callback(null, addrs);
        callback(null, addrs[0].address, addrs[0].family);
    });
}

// assertPublicUrl(urlStr)：非同步版的預先檢查，給直接用 fetch 的地方（串流、圖片代理）用，
// 因為 fetch 不能自訂 lookup。流程：格式檢查 -> 若是網域就查 DNS -> 任一結果為內網就丟錯。
// 先做一次 DNS 檢查 (給串流 / 圖片代理這類直接用 fetch 的地方)
async function assertPublicUrl(urlStr) {
    const u = assertUrlShape(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return u;
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new UnsafeUrlError('目標主機解析到內網位址，已阻擋');
    return u;
}

// decodeBody(buf, contentType)：把抓回來的二進位轉成字串，要猜對編碼，否則中文會變亂碼。
// 順序：HTTP 標頭的 charset -> 網頁前 2KB 的 <meta charset> -> 預設 utf-8。
// gb2312 實際用更完整的 gbk 解碼（簡體舊網站常見）。不認得的編碼就退回 utf8。
function decodeBody(buf, contentType) {
    let charset = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
    if (!charset) {
        const head = buf.subarray(0, 2048).toString('latin1');
        charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
    }
    charset = (charset || 'utf-8').toLowerCase();
    if (charset === 'gb2312') charset = 'gbk';
    try { return new TextDecoder(charset).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

/**
 * 安全抓取文字內容
 * @returns {Promise<{status:number, url:string, text:string, headers:object}>}
 */
function safeFetchText(urlStr, opts = {}) {
    // 選項預設值：GET、逾時 10 秒、回應上限 3MB、最多轉址 5 次。
    const {
        method = 'GET', headers = {}, body = null,
        timeoutMs = 10000, maxBytes = 3 * 1024 * 1024, maxRedirects = 5
    } = opts;

    // 用 Promise 包裝 callback 風格的 http.request，呼叫端可以用 await。成功 resolve 結果，失敗 reject 錯誤。
    return new Promise((resolve, reject) => {
        let u;
        try { u = assertUrlShape(urlStr); } catch (e) { return reject(e); }

        const client = u.protocol === 'https:' ? https : http;
        // 預設標頭；Accept-Encoding 告訴對方可壓縮傳輸（省流量），下面會自己解壓縮。呼叫端傳的 headers 可覆蓋預設。
        const reqHeaders = {
            'User-Agent': DEFAULT_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
            'Accept-Language': 'zh-TW,zh;q=0.9,zh-CN;q=0.8,ja;q=0.6,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers
        };
        if (body != null) reqHeaders['Content-Length'] = Buffer.byteLength(body);

        const req = client.request(u, { method, headers: reqHeaders, lookup: safeLookup, timeout: timeoutMs }, (res) => {
            const status = res.statusCode || 0;
            // 處理轉址 (3xx)：res.resume() 丟掉內容釋放連線；超過次數就報錯；
            // 否則遞迴呼叫自己抓新網址（會重新跑一次安全檢查，防止被轉址到內網）。
            // 只有 307/308 保留原方法與內容，其他轉址改用 GET 並丟掉 body。
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (maxRedirects <= 0) return reject(new Error('轉址次數過多'));
                const next = new URL(res.headers.location, u).toString();
                const keepPost = status === 307 || status === 308;
                return resolve(safeFetchText(next, { ...opts, method: keepPost ? method : 'GET', body: keepPost ? body : null, maxRedirects: maxRedirects - 1 }));
            }

            // 先看對方宣告的 Content-Length，太大就直接中斷不下載。
            const declared = Number(res.headers['content-length'] || 0);
            if (declared > maxBytes) {
                res.destroy();
                return reject(new Error(`回應過大 (${Math.round(declared / 1024)} KB)`));
            }

            // 依 Content-Encoding 用 zlib 解壓縮（gzip / deflate / brotli）。
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

            // 邊收邊累加大小：Content-Length 可能不存在或說謊，所以收資料時也要檢查上限，超過就中斷。
            const chunks = [];
            let size = 0;
            stream.on('data', (c) => {
                size += c.length;
                if (size > maxBytes) {
                    res.destroy();
                    stream.destroy();
                    reject(new Error(`回應超過 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`));
                    return;
                }
                chunks.push(c);
            });
            stream.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({ status, url: u.toString(), headers: res.headers, text: decodeBody(buf, res.headers['content-type']) });
            });
            stream.on('error', reject);
        });

        // 逾時處理：socket 閒置超過 timeoutMs 就主動中止並以錯誤結束。
        req.on('timeout', () => req.destroy(new Error(`連線逾時 (${Math.round(timeoutMs / 1000)} 秒)`)));
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

/**
 * 安全開啟串流 (給影片 / 圖片代理用)：不讀進記憶體，回傳上游回應讓呼叫端 pipe。
 * 每一跳轉址都重新檢查網址，且連線時由 safeLookup 檢查 DNS 結果。
 * headersFor(url) 可依每一跳的主機決定標頭 (例如 B 站要帶 Referer)。
 * @returns {Promise<{ upstream: import('http').IncomingMessage, request: import('http').ClientRequest, url: string }>}
 */
function safeRequestStream(urlStr, { headersFor = () => ({}), timeoutMs = 15000, maxRedirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = assertUrlShape(urlStr); } catch (e) { return reject(e); }
        const client = u.protocol === 'https:' ? https : http;
        const request = client.request(u, { method: 'GET', headers: headersFor(u), lookup: safeLookup, timeout: timeoutMs }, (upstream) => {
            const status = upstream.statusCode || 0;
            if (status >= 300 && status < 400 && upstream.headers.location) {
                upstream.resume();
                if (maxRedirects <= 0) return reject(new Error('轉址次數過多'));
                let next;
                try { next = new URL(upstream.headers.location, u).toString(); } catch (e) { return reject(new UnsafeUrlError('轉址網址格式無效')); }
                return resolve(safeRequestStream(next, { headersFor, timeoutMs, maxRedirects: maxRedirects - 1 }));
            }
            // 連上之後就不限時 (影片串流可能很久)，只限制建立連線 / 等待回應的時間
            request.setTimeout(0);
            resolve({ upstream, request, url: u.toString() });
        });
        request.on('timeout', () => request.destroy(new Error(`連線逾時 (${Math.round(timeoutMs / 1000)} 秒)`)));
        request.on('error', reject);
        request.end();
    });
}

// readJsonBody(req, limit)：讀取 POST 請求的 JSON 內容。參數 req 請求、limit 上限（預設 256KB）。
// 回傳 Promise 解析成物件；沒內容回傳 {}；超過上限或不是合法 JSON 就 reject。上限可防有人送超大內容塞爆記憶體。
// 讀取 POST JSON body (自訂規則請求很小，上限 256 KB)
function readJsonBody(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('請求內容過大')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('JSON 格式錯誤')); }
        });
        req.on('error', reject);
    });
}

// 對外匯出：抓取、串流、檢查函式與共用常數。
module.exports = { safeFetchText, safeRequestStream, assertPublicUrl, assertUrlShape, isPrivateIp, safeLookup, readJsonBody, UnsafeUrlError, DEFAULT_UA };
