/**
 * Web Library - NeDB 嵌入式非同步資料庫核心模組 (nedb-promises)
 * 支援多集合管理 (accounts, bookmarks, bookshelf)、加鹽雜湊密碼安全防護與自動資料遷移
 */
const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 建立三個獨立的 NoSQL 集合
const accountsDb = Datastore.create({ filename: path.join(DATA_DIR, 'accounts.db'), autoload: true });
const bookmarksDb = Datastore.create({ filename: path.join(DATA_DIR, 'bookmarks.db'), autoload: true });
const bookshelfDb = Datastore.create({ filename: path.join(DATA_DIR, 'bookshelf.db'), autoload: true });

// 建立唯一索引以加速查詢並防範重複資料
accountsDb.ensureIndex({ fieldName: 'username', unique: true }).catch(() => {});
bookmarksDb.ensureIndex({ fieldName: 'user', unique: true }).catch(() => {});
bookshelfDb.ensureIndex({ fieldName: 'user', unique: true }).catch(() => {});

// ==========================================
// 密碼加鹽安全雜湊 (Salted Hash via Node.js Native Crypto scrypt)
// ==========================================
function hashPassword(password) {
    if (!password) return '';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || !password) return false;
    // 相容性支援：若舊資料庫中存在早期明文密碼，進行安全比對
    if (!storedHash.startsWith('scrypt:')) {
        return password === storedHash;
    }
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const originalHash = parts[2];
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
    } catch (e) {
        return false;
    }
}

// ==========================================
// 自動無縫遷移 (從現有 JSON 檔案自動匯入 NeDB，密碼自動升級加鹽加密)
// ==========================================
let _isMigrated = false;
async function autoMigrate() {
    if (_isMigrated) return;
    _isMigrated = true;

    try {
        // 1. 遷移帳號 accounts.json
        const accountsCount = await accountsDb.count({});
        const accountsJsonPath = path.join(DATA_DIR, 'accounts.json');
        if (accountsCount === 0 && fs.existsSync(accountsJsonPath)) {
            const raw = fs.readFileSync(accountsJsonPath, 'utf8');
            const accounts = JSON.parse(raw || '[]');
            for (const acc of accounts) {
                if (acc.username) {
                    const u = acc.username.toLowerCase().trim();
                    const rawPwd = acc.password || '***REMOVED***';
                    const securedPwd = rawPwd.startsWith('scrypt:') ? rawPwd : hashPassword(rawPwd);
                    await accountsDb.insert({
                        username: u,
                        password: securedPwd,
                        name: acc.name || acc.username,
                        role: acc.role || '使用者',
                        avatar: acc.avatar || 'default',
                        bio: acc.bio || '',
                        sortPref: acc.sortPref || 'clicks',
                        themePref: acc.themePref || 'dark',
                        createdAt: acc.createdAt || new Date().toISOString(),
                        updatedAt: acc.updatedAt || new Date().toISOString()
                    });
                }
            }
            console.log(`[NeDB] 成功自動遷移 ${accounts.length} 筆帳號至 accounts.db (密碼全面升級加鹽加密)`);
        } else if (accountsCount === 0) {
            await accountsDb.insert([
                { username: 'admin', password: hashPassword('***REMOVED***'), name: '管理員 (Admin)', role: '系統管理員', avatar: 'default', bio: '系統全域管理員' },
                { username: 'student', password: hashPassword('***REMOVED***'), name: '學生 (Student)', role: '學生研究員', avatar: 'avatar-4', bio: '探索個人化網頁圖書館' },
                { username: 'jyun', password: hashPassword('***REMOVED***'), name: 'Jyun', role: '核心開發者', avatar: 'default', bio: '專案核心作者' }
            ]);
        }

        // 2. 遷移書籤 bookmarks_*.json
        const bookmarksCount = await bookmarksDb.count({});
        if (bookmarksCount === 0 && fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('bookmarks_') && file.endsWith('.json')) {
                    try {
                        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
                        const parsed = JSON.parse(raw);
                        const username = (parsed.user || file.replace('bookmarks_', '').replace('.json', '')).toLowerCase().trim();
                        const bookmarks = Array.isArray(parsed) ? parsed : (parsed.bookmarks || []);
                        await bookmarksDb.update(
                            { user: username },
                            { $set: { user: username, count: bookmarks.length, bookmarks, updatedAt: parsed.updatedAt || new Date().toISOString() } },
                            { upsert: true }
                        );
                    } catch (e) {}
                }
            }
            console.log(`[NeDB] 成功自動遷移書籤至 bookmarks.db`);
        }

        // 3. 遷移立體書架 bookshelf_*.json
        const bookshelfCount = await bookshelfDb.count({});
        if (bookshelfCount === 0 && fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('bookshelf_') && file.endsWith('.json')) {
                    try {
                        const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
                        const parsed = JSON.parse(raw);
                        const username = (parsed.user || file.replace('bookshelf_', '').replace('.json', '')).toLowerCase().trim();
                        await bookshelfDb.update(
                            { user: username },
                            { $set: { user: username, manga: parsed.manga || [], novel: parsed.novel || [], updatedAt: parsed.updatedAt || new Date().toISOString() } },
                            { upsert: true }
                        );
                    } catch (e) {}
                }
            }
            console.log(`[NeDB] 成功自動遷移立體書架至 bookshelf.db`);
        }
    } catch (err) {
        console.error('[NeDB Auto-Migrate Error]:', err.message);
    }
}

// 立即觸發一次自檢與遷移
autoMigrate();

module.exports = {
    accountsDb,
    bookmarksDb,
    bookshelfDb,
    hashPassword,
    verifyPassword,
    autoMigrate
};
