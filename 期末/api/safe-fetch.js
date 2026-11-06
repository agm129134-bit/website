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

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BLOCKED_HOST_SUFFIX = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet'];

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, p) => (acc * 256) + Number(p), 0);
}

const PRIVATE_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const n = ipv4ToInt(ip);
        return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
    }
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
    return true; // 不是合法 IP 一律視為不安全
}

class UnsafeUrlError extends Error {}

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

// 先做一次 DNS 檢查 (給串流 / 圖片代理這類直接用 fetch 的地方)
async function assertPublicUrl(urlStr) {
    const u = assertUrlShape(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return u;
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new UnsafeUrlError('目標主機解析到內網位址，已阻擋');
    return u;
}

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
    const {
        method = 'GET', headers = {}, body = null,
        timeoutMs = 10000, maxBytes = 3 * 1024 * 1024, maxRedirects = 5
    } = opts;

    return new Promise((resolve, reject) => {
        let u;
        try { u = assertUrlShape(urlStr); } catch (e) { return reject(e); }

        const client = u.protocol === 'https:' ? https : http;
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
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (maxRedirects <= 0) return reject(new Error('轉址次數過多'));
                const next = new URL(res.headers.location, u).toString();
                const keepPost = status === 307 || status === 308;
                return resolve(safeFetchText(next, { ...opts, method: keepPost ? method : 'GET', body: keepPost ? body : null, maxRedirects: maxRedirects - 1 }));
            }

            const declared = Number(res.headers['content-length'] || 0);
            if (declared > maxBytes) {
                res.destroy();
                return reject(new Error(`回應過大 (${Math.round(declared / 1024)} KB)`));
            }

            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

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

module.exports = { safeFetchText, safeRequestStream, assertPublicUrl, assertUrlShape, isPrivateIp, safeLookup, readJsonBody, UnsafeUrlError, DEFAULT_UA };
