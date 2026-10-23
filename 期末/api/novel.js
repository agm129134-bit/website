/**
 * Web Library - Legado 輕小說後端核心模組 (極簡重構版)
 * 核心數據徹底抽離至外部 JSON 資料檔 (data/novels_wenku8.json & data/novels_bilinovel.json)
 * 本模組僅保留純粹路由分發與查詢過濾，徹底告別龐大雜亂死代碼！
 */
const fs = require('fs');
const path = require('path');
const url = require('url');

const DATA_DIR = path.join(__dirname, '..', 'data');

// 統一設置 CORS 與 JSON 回應
function sendJson(res, statusCode, payload) {
    if (res.writableEnded) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(payload));
}

// 讀取外部書庫 JSON 檔案 (支援全空白檔案安全容錯與熱加載)
function loadNovelsBySource(source = 'wenku8') {
    const fileName = source === 'bilinovel' ? 'novels_bilinovel.json' : 'novels_wenku8.json';
    const filePath = path.join(DATA_DIR, fileName);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw) return [];
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        }
    } catch (e) {
        console.error(`[Novel API] 讀取 ${fileName} 略過:`, e.message);
    }
    return [];
}

// 根據關鍵字檢索小說
function searchNovels(query, source = 'wenku8') {
    const list = loadNovelsBySource(source);
    const q = (query || '').trim().toLowerCase();
    const sourceName = source === 'bilinovel' ? 'Bilinovel 嗶哩輕小說' : 'Wenku8 輕小說文庫';

    if (!q) {
        return list.map(n => ({
            id: n.id,
            source: n.source,
            sourceName: n.sourceName || sourceName,
            title: n.title,
            author: n.author,
            category: n.category,
            status: n.status,
            cover: n.cover,
            intro: n.intro,
            chapterCount: (n.volumes || []).reduce((acc, v) => acc + (v.chapters || []).length, 0)
        }));
    }

    return list.filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.author.toLowerCase().includes(q) ||
        (n.intro && n.intro.toLowerCase().includes(q))
    ).map(n => ({
        id: n.id,
        source: n.source,
        sourceName: n.sourceName || sourceName,
        title: n.title,
        author: n.author,
        category: n.category,
        status: n.status,
        cover: n.cover,
        intro: n.intro,
        chapterCount: (n.volumes || []).reduce((acc, v) => acc + (v.chapters || []).length, 0)
    }));
}

// 取得特定小說全量資料
function getNovelById(novelId, source = 'wenku8') {
    const list = loadNovelsBySource(source);
    let found = list.find(n => n.id === novelId);
    if (!found) {
        const otherSource = source === 'bilinovel' ? 'wenku8' : 'bilinovel';
        found = loadNovelsBySource(otherSource).find(n => n.id === novelId);
    }
    return found || null;
}

// 主路由處理器
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

    try {
        const source = (query.source || 'wenku8').toLowerCase();

        // 1. 小說搜尋: /api/novel/search?q=xxx&source=wenku8|bilinovel
        if (pathname === '/api/novel/search') {
            const results = searchNovels(query.q, source);
            return sendJson(res, 200, {
                success: true,
                source: source,
                count: results.length,
                results: results
            });
        }

        // 2. 取得章節目錄: /api/novel/chapters?novelId=xxx&source=xxx
        else if (pathname === '/api/novel/chapters') {
            const novel = getNovelById(query.novelId, source);
            if (!novel) {
                return sendJson(res, 404, { success: false, error: '找不到該作品' });
            }

            const flatChapters = [];
            (novel.volumes || []).forEach(v => {
                (v.chapters || []).forEach(ch => {
                    flatChapters.push({
                        ...ch,
                        volumeTitle: v.volumeTitle
                    });
                });
            });

            return sendJson(res, 200, {
                success: true,
                novelId: novel.id,
                title: novel.title,
                author: novel.author,
                cover: novel.cover,
                intro: novel.intro,
                volumes: novel.volumes || [],
                chapters: flatChapters,
                count: flatChapters.length
            });
        }

        // 3. 取得章節內文: /api/novel/content?novelId=xxx&chapterId=yyy&source=xxx
        else if (pathname === '/api/novel/content') {
            const novel = getNovelById(query.novelId, source);
            if (!novel) return sendJson(res, 404, { success: false, error: '找不到該作品' });

            let targetChapter = null;
            let targetVol = null;
            for (const v of (novel.volumes || [])) {
                const found = (v.chapters || []).find(c => c.id === query.chapterId);
                if (found) {
                    targetChapter = found;
                    targetVol = v;
                    break;
                }
            }

            if (!targetChapter && novel.volumes?.[0]?.chapters?.[0]) {
                targetChapter = novel.volumes[0].chapters[0];
                targetVol = novel.volumes[0];
            }

            return sendJson(res, 200, {
                success: true,
                novelId: novel.id,
                novelTitle: novel.title,
                author: novel.author,
                chapterId: targetChapter ? targetChapter.id : query.chapterId,
                title: targetChapter ? targetChapter.title : '章節內文',
                volumeTitle: targetVol ? targetVol.volumeTitle : '',
                paragraphs: targetChapter ? targetChapter.paragraphs : ['暫無正文']
            });
        }

        return sendJson(res, 404, { success: false, error: '找不到該 API 端點' });
    } catch (err) {
        console.error('[Novel API Error]:', err.message);
        return sendJson(res, 500, { success: false, error: err.message });
    }
}

module.exports = {
    handleNovelRoute,
    searchNovels,
    getNovelById
};
