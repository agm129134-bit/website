// 自動清洗本地既有的 (專案開發者) 尾綴
try {
    ['currentUser', 'web_library_auth_user'].forEach(k => {
        const val = localStorage.getItem(k) || sessionStorage.getItem(k);
        if (val && val.includes('專案開發者')) {
            const cleaned = val.replace(/\s*[\(（]專案開發者[\)）]/g, '');
            if (localStorage.getItem(k)) localStorage.setItem(k, cleaned);
            if (sessionStorage.getItem(k)) sessionStorage.setItem(k, cleaned);
        }
    });
    const regUsers = localStorage.getItem('registeredUsers');
    if (regUsers && regUsers.includes('專案開發者')) {
        localStorage.setItem('registeredUsers', regUsers.replace(/\s*[\(（]專案開發者[\)）]/g, ''));
    }
} catch (e) {}

/**

 * 網頁收藏圖書館 (Web Library) 前端核心邏輯

 * 具備 LocalStorage 持久化儲存、分類過濾、即時搜尋、卡片渲染、標籤動態統計與模擬篡改猴採集

 */

// ==========================================

// 1. 預設初始範例資料 (清空，交由使用者自行新增或由 Qwen 設計)

// ==========================================

const DEFAULT_BOOKMARKS = [];

// ==========================================

// 2. 狀態管理器 (State)

// ==========================================

const state = {

    bookmarks: [],

    activeCategory: "all",

    activeTag: "all",

    searchQuery: "",

    sortMode: "newest",

    viewMode: localStorage.getItem("web_library_view_mode") || "grid", // 'grid' | 'list' (持久化視圖偏好)

    currentUser: localStorage.getItem("web_library_user") || "jyun",

    apiToken: "usr_tok_8f92ab3c71e041d8b991a",

    isBatchMode: false,

    selectedBookmarkIds: new Set()

};

// ==========================================

// 3. 初始化與本地存儲 (Storage) & 跨電腦同步

// ==========================================

function initApp() {

    loadFromStorage();

    // 只有在首頁（存在 bookmarkContainer 與 categoryNav）時才初始化首頁 UI 與事件監聽

    if (document.getElementById("bookmarkContainer") && document.getElementById("categoryNav")) {

        // 防止瀏覽器 Autofill 將帳號誤填入搜尋輸入框

        const sInput = document.getElementById("searchInput");

        if (sInput) {

            sInput.value = "";

            state.searchQuery = "";

            setTimeout(() => {

                const u = (state.currentUser || "").toLowerCase().trim();

                if (sInput.value && u && sInput.value.toLowerCase().trim() === u) {

                    sInput.value = "";

                    state.searchQuery = "";

                    const clearBtn = document.getElementById("clearSearchBtn");

                    if (clearBtn) clearBtn.classList.add("d-none");

                    renderBookmarks();

                }

            }, 300);

        }

        setupEventListeners();

        updateUI();

    }

    // 啟動時自動背景向伺服器拉取最新跨電腦雲端同步書籤

    if (state.currentUser && state.currentUser !== "訪客") {

        syncFromServer(state.currentUser);

    }

    // 當使用者自其他分頁使用篡改猴 (Alt+B) 收藏後切回本網頁時，自動即時拉取最新書籤 (無須手動重整)

    window.addEventListener("focus", () => {

        if (_isLocalMutationActive) return; // 避免刪除彈窗復焦時誤觸發拉取競態

        if (state.currentUser && state.currentUser !== "訪客") {

            syncFromServer(state.currentUser, true);

        }

    });

}

function loadFromStorage() {

    const saved = localStorage.getItem("web_library_bookmarks");

    if (saved) {

        try {

            const parsed = JSON.parse(saved);

            // 若為先前的預設假資料，則主動清空，保持乾淨

            if (Array.isArray(parsed) && parsed.some(b => b.id === "bm_1" && b.title.includes("bootstrap"))) {

                state.bookmarks = [];

                saveToStorage();

            } else {

                state.bookmarks = parsed;

            }

        } catch (e) {

            console.error("解析存儲資料失敗，重置為空資料", e);

            state.bookmarks = [];

        }

    } else {

        state.bookmarks = [];

        saveToStorage();

    }

    // 優先讀取登入驗證身分 (currentUser)

    const authUserStr = localStorage.getItem("currentUser") || sessionStorage.getItem("currentUser");

    if (authUserStr) {

        try {

            const authUser = JSON.parse(authUserStr);

            if (authUser) {

                // 關鍵修復：state.currentUser 永遠使用純淨的 username (如 'jyun', 'admin', 'student') 作為伺服器同步識別碼！

                let rawU = (authUser.username || authUser.name || "").trim();

                let cleanU = rawU.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '').trim();

                if (cleanU.startsWith('Jyun') || cleanU.startsWith('jyun')) state.currentUser = 'jyun';

                else if (cleanU.startsWith('Test1') || cleanU.startsWith('test1')) state.currentUser = 'test1';

                else if (cleanU.startsWith('admin')) state.currentUser = 'admin';

                else if (cleanU.startsWith('student')) state.currentUser = 'student';

                else if (authUser.username) state.currentUser = authUser.username.toLowerCase().trim();

                else state.currentUser = cleanU.toLowerCase();

                let rawDisp = authUser.name || authUser.username || state.currentUser;
                state.displayUserName = rawDisp.replace(/\s*[\(（]專案開發者[\)）]/g, '').trim();

            }

        } catch (e) {}

    } else {

        const savedUser = localStorage.getItem("web_library_user");

        if (savedUser) state.currentUser = savedUser.toLowerCase().trim();

        state.displayUserName = state.currentUser;

    }

    const savedToken = localStorage.getItem("web_library_token");

    if (savedToken) state.apiToken = savedToken;

}

// 帳號登出函數

window.logoutUser = function() {

    if (confirm("確定要登出個人圖書館帳號嗎？")) {

        localStorage.removeItem("currentUser");

        sessionStorage.removeItem("currentUser");

        showToast("已成功登出帳號，正在返回登入頁面...", "bi-box-arrow-right text-warning");

        setTimeout(() => {

            window.location.replace("login.html");

        }, 500);

    }

};

// 刪除當前帳號函數 (雙重確認 + 伺服器端資料徹底刪除)

window.confirmDeleteCurrentAccount = async function() {

    const user = state.currentUser;

    if (!user || user === "訪客") {

        showToast("訪客帳號無需刪除", "bi-info-circle text-info");

        return;

    }

    const confirmMsg = `⚠️ 警告：確定要徹底刪除當前帳號【${user}】嗎？\n\n• 將永久清空該帳號的所有書籤收藏與雲端備份。\n• 此操作無法復原！\n\n請點擊「確定」執行刪除。`;

    if (!confirm(confirmMsg)) return;

    try {

        // 1. 向伺服器發送刪除請求

        await fetch(`/api/user/delete?user=${encodeURIComponent(user)}`, { method: 'POST' });

        

        // 2. 清除本機 registeredUsers 清單中的此帳號，並加入永久刪除黑名單

        try {

            let deletedUsers = [];

            try {

                const rawDeleted = localStorage.getItem('deletedUsers');

                if (rawDeleted) deletedUsers = JSON.parse(rawDeleted);

                if (!Array.isArray(deletedUsers)) deletedUsers = [];

            } catch (e) { deletedUsers = []; }

            if (!deletedUsers.some(d => d.toLowerCase() === user.toLowerCase())) {

                deletedUsers.push(user);

                localStorage.setItem('deletedUsers', JSON.stringify(deletedUsers));

            }

            const rawUsers = localStorage.getItem('registeredUsers');

            if (rawUsers) {

                let users = JSON.parse(rawUsers);

                if (Array.isArray(users)) {

                    users = users.filter(u => (u.username || '').toLowerCase() !== user.toLowerCase() && (u.name || '').toLowerCase() !== user.toLowerCase());

                    localStorage.setItem('registeredUsers', JSON.stringify(users));

                }

            }

        } catch (e) {}

        // 3. 清理本機當前快取

        localStorage.removeItem("currentUser");

        sessionStorage.removeItem("currentUser");

        localStorage.removeItem("web_library_user");

        localStorage.removeItem("web_library_bookmarks");

        localStorage.removeItem("web_library_token");

        showToast(`帳號【${user}】已永久刪除，正在返回登入頁面...`, "bi-trash-fill text-danger");

        setTimeout(() => {

            window.location.replace("login.html");

        }, 800);

    } catch (err) {

        console.error("刪除帳號失敗:", err);

        localStorage.removeItem("currentUser");

        sessionStorage.removeItem("currentUser");

        window.location.replace("login.html");

    }

};

// 跨電腦雲端自動同步計時器 (支援防抖 Debounce 與刪除操作立即同步)

let _cloudSyncDebounceTimer = null;

let _isLocalMutationActive = false; // 本地主動修改鎖 (避免 confirm 彈窗關閉導致 window.focus 誤拉取舊書籤復活)

async function syncToServer(immediate = false) {

    const user = state.currentUser;

    if (!user || user === "訪客") return;

    clearTimeout(_cloudSyncDebounceTimer);

    const doSync = async () => {

        try {

            const res = await fetch('/api/user/bookmarks', {

                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({

                    user: user,

                    bookmarks: state.bookmarks

                })

            });

            const data = await res.json();

            if (data && data.success) {

                console.log(`[Cloud Sync] 跨電腦同步：已成功持久化至伺服器 (${data.count} 筆)`);

            }

        } catch (e) {

            console.warn('[Cloud Sync] 同步至伺服器提示 (離線模式):', e.message);

        }

    };

    if (immediate) {

        await doSync();

    } else {

        _cloudSyncDebounceTimer = setTimeout(doSync, 500);

    }

}

// 從伺服器拉取跨裝置收藏 (支援平滑雙向合併，防止已被刪除的項目復活)

async function syncFromServer(username, isFocusSync = false) {

    if (_isLocalMutationActive) return; // 正在進行本地刪除/修改，不覆蓋

    let user = username || state.currentUser;

    if (!user || user === "期末展示學生" || user === "default") user = "jyun";

    if (user === "訪客") return;

    try {

        const res = await fetch(`/api/user/bookmarks?user=${encodeURIComponent(user)}`);

        if (!res.ok) return;

        const data = await res.json();

        if (data && data.success && Array.isArray(data.bookmarks)) {

            if (!isFocusSync) {

                // 登入或整頁刷新：以伺服器端實際儲存為準

                state.bookmarks = data.bookmarks;

                localStorage.setItem("web_library_bookmarks", JSON.stringify(state.bookmarks));

                updateUI();

            } else {

                // 切換分頁無感同步（Alt+B 外部擴充新增）：僅合併伺服器端真正新加入的書籤

                let added = 0;

                const existingUrls = new Set(state.bookmarks.map(b => b.url).filter(Boolean));

                const existingIds = new Set(state.bookmarks.map(b => b.id).filter(Boolean));

                data.bookmarks.forEach(sb => {

                    const has = (sb.id && existingIds.has(sb.id)) || (sb.url && existingUrls.has(sb.url));

                    if (!has) {

                        state.bookmarks.unshift(sb);

                        added++;

                    }

                });

                if (added > 0) {

                    localStorage.setItem("web_library_bookmarks", JSON.stringify(state.bookmarks));

                    updateUI();

                    showToast(`☁️ 跨電腦同步：已從伺服器合併新增 ${added} 部新收藏！`, "bi-cloud-download-fill text-success");

                }

            }

        }

    } catch (e) {

        console.warn('[Cloud Sync] 從伺服器拉取失敗 (若為純靜態環境屬正常):', e.message);

    }

}

function saveToStorage(immediate = false) {

    localStorage.setItem("web_library_bookmarks", JSON.stringify(state.bookmarks));

    localStorage.setItem("web_library_user", state.currentUser);

    localStorage.setItem("web_library_token", state.apiToken);

    // 自動觸發跨電腦伺服器端同步備份

    syncToServer(immediate);

}

// ==========================================

// 3.1 Bangumi 雙向同步 (Token 管理與 API 代理回寫)

// ==========================================

window.toggleTokenVisibility = function(inputId, btnEl) {

    const input = document.getElementById(inputId);

    if (!input) return;

    if (input.type === 'password') {

        input.type = 'text';

        if (btnEl) btnEl.innerHTML = '<i class="bi bi-eye-slash"></i>';

    } else {

        input.type = 'password';

        if (btnEl) btnEl.innerHTML = '<i class="bi bi-eye"></i>';

    }

};

window.getBangumiToken = function() {

    return localStorage.getItem("bangumi_access_token") || "";

};

window.setBangumiToken = function(token) {

    if (token && token.trim()) {

        localStorage.setItem("bangumi_access_token", token.trim());

    } else {

        localStorage.removeItem("bangumi_access_token");

    }

};

window.saveBgmPriority = function(val) {

    localStorage.setItem("bangumi_conflict_priority", val || "bangumi");

};

window.getBgmPriority = function() {

    return localStorage.getItem("bangumi_conflict_priority") || "bangumi";

};

// 驗證 Bangumi 個人授權令牌 (Token) 是否有效

window.verifyBangumiToken = async function() {

    const tokenInput = document.getElementById("bgmTokenInput");

    const statusBox = document.getElementById("bgmTokenStatus");

    const verifyBtn = document.getElementById("btnVerifyBgmToken");

    const usernameInput = document.getElementById("bgmUsernameInput");

    const token = tokenInput ? tokenInput.value.trim() : "";

    if (!token) {

        if (statusBox) {

            statusBox.className = "small mt-1 text-danger d-block";

            statusBox.innerHTML = '<i class="bi bi-exclamation-circle"></i> 請先貼上 Bangumi Access Token 再進行驗證。';

        }

        if (typeof showToast === "function") showToast("請先輸入 Bangumi Access Token", "bi-exclamation-circle text-warning");

        return;

    }

    if (verifyBtn) {

        verifyBtn.disabled = true;

        verifyBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> 驗證中...';

    }

    if (statusBox) {

        statusBox.className = "small mt-1 text-muted d-block";

        statusBox.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> 正在向 Bangumi /v0/me 驗證令牌...';

    }

    try {

        const res = await fetch('/api/bangumi/me', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ token })

        });

        const result = await res.json();

        if (res.ok && result.success && result.user) {

            const user = result.user;

            window.setBangumiToken(token);

            const displayName = user.nickname || user.username || "Bangumi 用戶";

            const uidStr = user.username || user.id || "";

            if (statusBox) {

                statusBox.className = "small mt-1 text-success fw-semibold d-block";

                statusBox.innerHTML = `<i class="bi bi-check-circle-fill"></i> 令牌驗證成功！使用者：<strong>${escapeHtml(displayName)}</strong> (@${escapeHtml(uidStr)})`;

            }

            // 若使用者名稱輸入框為空或預設值，自動填入對應的 Bangumi 用戶名

            if (usernameInput && (!usernameInput.value.trim() || usernameInput.value.trim() === 'sai')) {

                usernameInput.value = uidStr;

            }

            if (typeof showToast === "function") showToast(`🎉 Bangumi 令牌驗證成功：${displayName}`, "bi-shield-check text-success");

        } else {

            const errMsg = result.error || (result.details && result.details.description) || "令牌無效或已過期";

            if (statusBox) {

                statusBox.className = "small mt-1 text-danger fw-semibold d-block";

                statusBox.innerHTML = `<i class="bi bi-x-circle-fill"></i> 驗證失敗：${escapeHtml(errMsg)}`;

            }

            if (typeof showToast === "function") showToast(`❌ 令牌驗證失敗：${errMsg}`, "bi-x-circle text-danger");

        }

    } catch (err) {

        console.error("驗證 Bangumi Token 出錯", err);

        if (statusBox) {

            statusBox.className = "small mt-1 text-danger fw-semibold d-block";

            statusBox.innerHTML = `<i class="bi bi-wifi-off"></i> 連線伺服器失敗：${escapeHtml(err.message)}`;

        }

        if (typeof showToast === "function") showToast("伺服器連線失敗", "bi-wifi-off text-danger");

    } finally {

        if (verifyBtn) {

            verifyBtn.disabled = false;

            verifyBtn.innerHTML = '<i class="bi bi-shield-check"></i> 驗證令牌';

        }

    }

};

// 雙向同步：向 Bangumi 官方回寫收藏狀態 (1:想看, 2:看過, 3:在看, 4:擱置, 5:拋棄)

window.syncStatusToBangumi = async function(subjectId, statusType = 3, rating = null, comment = null) {

    const token = window.getBangumiToken();

    if (!token) {

        showToast("尚未填寫 Bangumi Token，請在「同步 Bangumi」設定個人令牌以啟用雙向回寫", "bi-key text-warning");

        return false;

    }

    try {

        const res = await fetch('/api/bangumi/collection', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ token, subjectId, type: statusType, rating, comment })

        });

        const data = await res.json();

        if (data.success) {

            const statusNames = { 1: "想看", 2: "看過", 3: "在看", 4: "擱置", 5: "拋棄" };

            showToast(`🎉 已成功同步回寫 Bangumi：狀態改為「${statusNames[statusType] || '在看'}」！`, "bi-cloud-check-fill text-success");

            return true;

        } else {

            showToast(`Bangumi 同步失敗: ${data.error || '授權已過期'}`, "bi-exclamation-triangle text-danger");

            return false;

        }

    } catch (e) {

        console.error("同步至 Bangumi 失敗", e);

        showToast("同步至 Bangumi 網路錯誤: " + e.message, "bi-wifi-off text-danger");

        return false;

    }

};

// 雙向同步：向 Bangumi 官方自動更新集數/話數進度

window.syncEpisodeProgressToBangumi = async function(subjectId, episodeId = null, watchedEpisodes = null) {

    const token = window.getBangumiToken();

    if (!token) return false;

    try {

        const payload = { token, subjectId };

        if (episodeId) payload.episodeId = episodeId;

        if (watchedEpisodes !== null && watchedEpisodes !== undefined) payload.watchedEpisodes = watchedEpisodes;

        const res = await fetch('/api/bangumi/episodes', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify(payload)

        });

        const data = await res.json();

        if (data.success) {

            showToast(`🎉 已自動雙向同步進度至 Bangumi (第 ${watchedEpisodes || episodeId} 集/話)！`, "bi-check2-all text-primary");

            return true;

        }

    } catch (e) {

        console.warn("自動同步 Bangumi 集數進度失敗:", e.message);

    }

    return false;

};

// ==========================================

// 4. UI 渲染邏輯 (Card Rendering)

// ==========================================

function updateUI() {

    if (!document.getElementById("bookmarkContainer")) return;

    updateStats();

    renderTagChips();

    renderBookmarks();

    const navUsername = document.getElementById("navUsername");

    if (navUsername) {
        let cleanName = (state.displayUserName || state.currentUser || "Jyun").replace(/\s*[\(（]專案開發者[\)）]/g, '').trim();
        navUsername.textContent = cleanName;
    }

    const userApiTokenInput = document.getElementById("userApiTokenInput");

    if (userApiTokenInput) userApiTokenInput.value = state.apiToken;

}

// 動畫項目判定 (由 Qwen 27B 設計之多重條件比對)

function isAnimeItem(item) {

    if (!item) return false;

    if (item.category === "anime") return true;

    const tags = Array.isArray(item.tags) ? item.tags.join(" ") : (item.tags || "");

    if (/動漫|動畫|Bangumi同步|本季新番/i.test(tags)) return true;

    if (/bgm\.tv/i.test(item.url || "")) return true;

    return false;

}

// 統計數量更新

function updateStats() {

    const statWeb = document.getElementById("statWebCount");

    if (!statWeb) return;

    const animeCount = state.bookmarks.filter(isAnimeItem).length;

    const webCount = state.bookmarks.filter(b => b.category === "web" && !isAnimeItem(b)).length;

    const videoCount = state.bookmarks.filter(b => b.category === "video" && !isAnimeItem(b)).length;

    const resCount = state.bookmarks.filter(b => (b.category === "resource" || !b.category) && !isAnimeItem(b)).length;

    const totalCount = state.bookmarks.length;

    statWeb.textContent = webCount;

    const statVideo = document.getElementById("statVideoCount");

    if (statVideo) statVideo.textContent = videoCount;

    const statRes = document.getElementById("statResCount");

    if (statRes) statRes.textContent = animeCount + resCount;

    const bAll = document.getElementById("badgeAllCount");

    if (bAll) bAll.textContent = totalCount;

    const bAnime = document.getElementById("badgeAnimeCount");

    if (bAnime) bAnime.textContent = animeCount;

    const bWeb = document.getElementById("badgeWebCount");

    if (bWeb) bWeb.textContent = webCount;

    const bVideo = document.getElementById("badgeVideoCount");

    if (bVideo) bVideo.textContent = videoCount;

    const bRes = document.getElementById("badgeResCount");

    if (bRes) bRes.textContent = resCount;

}

// 標籤篩選晶片動態渲染

function renderTagChips() {

    const container = document.getElementById("tagFiltersContainer");

    if (!container) return;

    const allTags = new Set();

    state.bookmarks.forEach(b => {

        if (Array.isArray(b.tags)) {

            b.tags.forEach(t => allTags.add(t.trim()));

        }

    });

    // 保留 "全部標籤" 按鈕

    container.innerHTML = `

        <span class="small text-muted d-flex align-items-center gap-1">

            <i class="bi bi-tags-fill"></i> 標籤篩選：

        </span>

        <button class="btn btn-xs rounded-pill tag-chip ${state.activeTag === 'all' ? 'active' : ''}" data-tag="all">全部標籤</button>

    `;

    allTags.forEach(tag => {

        if (!tag) return;

        const btn = document.createElement("button");

        btn.className = `btn btn-xs rounded-pill tag-chip ${state.activeTag === tag ? 'active' : ''}`;

        btn.setAttribute("data-tag", tag);

        btn.textContent = tag;

        btn.addEventListener("click", () => {

            state.activeTag = tag;

            renderTagChips();

            renderBookmarks();

        });

        container.appendChild(btn);

    });

    // 重新綁定 "全部標籤" 點擊

    container.querySelector('[data-tag="all"]').addEventListener("click", () => {

        state.activeTag = "all";

        renderTagChips();

        renderBookmarks();

    });

}

// 篩選與排序核心運算

function getFilteredAndSortedBookmarks() {

    let result = [...state.bookmarks];

    // 1. 分類過濾 (動漫與資源包含動漫與資源索引)

    if (state.activeCategory !== "all") {

        if (state.activeCategory === "anime") {

            result = result.filter(isAnimeItem);

        } else if (state.activeCategory === "resource") {

            result = result.filter(b => b.category === "resource" || isAnimeItem(b));

        } else {

            result = result.filter(b => b.category === state.activeCategory && !isAnimeItem(b));

        }

    }

    // 2. 標籤過濾

    if (state.activeTag !== "all") {

        result = result.filter(b => Array.isArray(b.tags) && b.tags.includes(state.activeTag));

    }

    // 3. 搜尋字串比對 (標題、網址、描述或標籤)

    const rawSearch = (state.searchQuery || "").trim();

    const currentU = (state.currentUser || "").toLowerCase().trim();

    // 智慧防護：若搜尋詞與當前登入者帳號完全相同（因瀏覽器 Autofill 誤填），自動忽略過濾

    if (rawSearch !== "" && rawSearch.toLowerCase() !== currentU) {

        const q = rawSearch.toLowerCase();

        result = result.filter(b => {

            const inTitle = b.title && b.title.toLowerCase().includes(q);

            const inUrl = b.url && b.url.toLowerCase().includes(q);

            const inDesc = b.desc && b.desc.toLowerCase().includes(q);

            const inTags = Array.isArray(b.tags) && b.tags.some(t => t.toLowerCase().includes(q));

            return inTitle || inUrl || inDesc || inTags;

        });

    }

    // 4. 排序方式

    switch (state.sortMode) {

        case "pinned":

            result.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

            break;

        case "clicks":

            result.sort((a, b) => (b.clicks || 0) - (a.clicks || 0));

            break;

        case "title":

            result.sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));

            break;

        case "newest":

        default:

            result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            break;

    }

    return result;

}

// 一鍵清除所有搜尋與篩選條件

window.resetAllFilters = function() {

    state.searchQuery = "";

    state.activeCategory = "all";

    state.activeTag = "all";

    const searchInput = document.getElementById("searchInput");

    if (searchInput) searchInput.value = "";

    const clearBtn = document.getElementById("clearSearchBtn");

    if (clearBtn) clearBtn.classList.add("d-none");

    const categoryNav = document.getElementById("categoryNav");

    if (categoryNav) {

        categoryNav.querySelectorAll(".nav-link").forEach(link => {

            if (link.getAttribute("data-category") === "all") link.classList.add("active");

            else link.classList.remove("active");

        });

    }

    renderTagChips();

    renderBookmarks();

    showToast("已重置所有篩選，顯示全部收藏作品！", "bi-check-circle-fill text-success");

};

// 收藏卡片生成渲染

function renderBookmarks(skipAnimation = false) {

    const container = document.getElementById("bookmarkContainer");

    const emptyState = document.getElementById("emptyState");

    const items = getFilteredAndSortedBookmarks();

    container.innerHTML = "";

    if (items.length === 0) {

        emptyState.classList.remove("d-none");

        const descEl = document.getElementById("emptyStateDescription");

        const resetBtn = document.getElementById("resetFiltersBtn");

        const hasFilters = (state.searchQuery && state.searchQuery.trim() !== "") || state.activeCategory !== "all" || state.activeTag !== "all";

        if (descEl) {

            if (state.searchQuery && state.searchQuery.trim() !== "") {

                descEl.innerHTML = `目前搜尋關鍵字：<span class="badge bg-secondary">"${escapeHtml(state.searchQuery)}"</span>，未找到相符作品。`;

            } else if (state.activeCategory !== "all" || state.activeTag !== "all") {

                descEl.textContent = "目前分類或標籤下暫無作品，點擊下方按鈕可清除篩選恢復全部作品。";

            } else {

                descEl.textContent = "嘗試更換搜尋關鍵字、標籤分類，或者點擊上方按鈕新增第一篇收藏！";

            }

        }

        if (resetBtn) {

            if (hasFilters) resetBtn.classList.remove("d-none");

            else resetBtn.classList.add("d-none");

        }

        return;

    }

    emptyState.classList.add("d-none");

    const isList = state.viewMode === "list";

    const colClass = isList ? "col-12 bookmark-col" : "col-12 col-md-6 col-xl-4 bookmark-col";

    items.forEach(item => {

        const col = document.createElement("div");

        col.className = colClass;

        // 分類徽章與圖示設定

        let catBadgeClass = "badge-cat-web";

        let catLabel = "一般網頁";

        let catIcon = "bi-globe2";

        if (isAnimeItem(item)) {

            catBadgeClass = "badge-cat-anime";

            const tags = Array.isArray(item.tags) ? item.tags.join(" ") : (item.tags || "");

            catLabel = /新番/i.test(tags) ? "動畫新番" : "動畫";

            catIcon = "bi-broadcast";

        } else if (item.category === "video") {

            catBadgeClass = "badge-cat-video";

            catLabel = "影片影音";

            catIcon = "bi-play-btn-fill";

        } else if (item.category === "resource") {

            catBadgeClass = "badge-cat-resource";

            catLabel = "動漫資源";

            catIcon = "bi-box-seam-fill";

        }

        // 解析網域名稱與 Favicon

        let hostname = "";

        try {

            hostname = new URL(item.url).hostname;

        } catch (e) {

            hostname = item.url;

        }

        const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

        // 標籤 HTML

        const tagsHtml = (item.tags || []).map(t => `<span class="tag-badge">#${escapeHtml(t)}</span>`).join("");

        // 預設封面圖備援

        const fallbackCover = "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=700&q=80";

        const coverSrc = item.cover && item.cover.trim() !== "" ? item.cover : fallbackCover;

        // 批量選取狀態

        const isSelected = state.selectedBookmarkIds.has(item.id);

        const batchSelectedClass = (state.isBatchMode && isSelected) ? "batch-selected" : "";

        const checkboxHtml = state.isBatchMode ? `

            <div class="bookmark-batch-checkbox position-absolute top-0 start-0 m-2" onclick="event.stopPropagation()">

                <input class="form-check-input shadow" type="checkbox" id="check_${item.id}" ${isSelected ? 'checked' : ''} onchange="toggleSelectBookmark('${item.id}', this.checked)">

            </div>

        ` : '';

        const cardClickAttr = state.isBatchMode ? `onclick="toggleSelectBookmark('${item.id}')"` : '';

        const cardCursorStyle = state.isBatchMode ? 'style="cursor: pointer;"' : '';

        col.innerHTML = `

            <div class="card bookmark-card shadow-sm h-100 position-relative ${batchSelectedClass}" ${cardClickAttr} ${cardCursorStyle}>

                ${checkboxHtml}

                <!-- 封面圖區域 (點擊放大查看大圖) -->

                <div class="card-cover-wrapper" onclick="event.stopPropagation(); openImagePreview('${escapeHtml(coverSrc)}', '${escapeHtml(item.title)}')">

                    <img src="${escapeHtml(coverSrc)}" class="card-cover-img" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='${fallbackCover}'">

                    <div class="cover-zoom-badge" title="點擊放大預覽圖片"><i class="bi bi-arrows-fullscreen"></i></div>

                    

                    ${item.pinned ? `<div class="pin-badge"><i class="bi bi-pin-angle-fill"></i> 置頂</div>` : ''}

                    <div class="category-floating-badge ${catBadgeClass}">

                        <i class="bi ${catIcon} me-1"></i>${catLabel}

                    </div>

                </div>

                <!-- 卡片主要內容 -->

                <div class="card-content-body">

                    <!-- 網站來源 Meta -->

                    <div class="card-site-meta">

                        <img src="${faviconUrl}" class="site-favicon" alt="icon" onerror="this.style.display='none'">

                        <span>${escapeHtml(hostname)}</span>

                        <span class="ms-auto click-counter-badge" title="累計跳轉次數">

                            <i class="bi bi-cursor-fill text-primary"></i> ${item.clicks || 0} 次點擊

                        </span>

                    </div>

                    <!-- 標題 -->

                    <h6 class="card-title-text" title="${escapeHtml(item.title)}">

                        ${escapeHtml(item.title)}

                    </h6>

                    <!-- 描述備註 -->

                    <p class="card-desc-text">

                        ${escapeHtml(item.desc || "暫無備註資訊。")}

                    </p>

                    <!-- 標籤列表 -->

                    <div class="card-tags">

                        ${tagsHtml}

                    </div>

                    <!-- 底部操作列 -->

                    <div class="card-actions-footer" onclick="event.stopPropagation()">

                        <div class="d-flex align-items-center gap-1 flex-wrap">

                            <button class="btn btn-dark btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="jumpToBookmark('${item.id}')">

                                <i class="bi bi-box-arrow-up-right"></i> 前往

                            </button>

                            ${isAnimeItem(item) ? `

                            <button class="btn btn-outline-danger btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="playAnimeBookmark('${item.id}')" title="透過 Kazumi 全網檢索並開播">

                                <i class="bi bi-play-circle-fill"></i> Kazumi 播放

                            </button>` : ''}

                            ${(item.category === 'video' || (item.url && (item.url.includes('bilibili.com') || item.url.includes('youtube.com') || item.url.includes('youtu.be')))) && !isAnimeItem(item) ? `

                            <button class="btn btn-outline-danger btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="playVideoBookmark('${item.id}')">

                                <i class="bi bi-play-circle-fill"></i> 播放

                            </button>` : ''}

                            ${Array.isArray(item.tags) && item.tags.some(t => t.includes('漫畫') || t.includes('条漫')) ? `

                            <button class="btn btn-outline-primary btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="readMangaBookmark('${item.id}')">

                                <i class="bi bi-journal-richtext"></i> 漫畫

                            </button>` : ''}

                            ${Array.isArray(item.tags) && item.tags.some(t => t.includes('小說') || t.includes('文庫')) ? `

                            <button class="btn btn-outline-success btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="openLegadoWithTitle('${escapeHtml(item.title)}')">

                                <i class="bi bi-book-half"></i> 小說

                            </button>` : ''}

                            ${(isAnimeItem(item) || (Array.isArray(item.tags) && item.tags.some(t => t.includes('漫畫') || t.includes('条漫') || t.includes('動畫') || t.includes('番劇')))) ? `

                            <div class="dropdown d-inline-block">

                                <button class="btn btn-outline-info btn-sm action-jump-btn dropdown-toggle d-flex align-items-center gap-1 bookmark-watch-status-btn" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="變更是否看/讀過並同步至 Bangumi">

                                    <i class="bi bi-bookmark-check"></i> <span id="bmWatchStatusText_${item.id}">${getBookmarkWatchStatusLabel(item)}</span>

                                </button>

                                <ul class="dropdown-menu dropdown-menu-dark shadow-sm" style="font-size: 0.8rem; z-index: 1050;">

                                    <li><h6 class="dropdown-header small" style="color: #38bdf8 !important;">Bangumi 狀態同步</h6></li>

                                    <li><a class="dropdown-item" href="#" onclick="updateCardWatchStatus('${item.id}', 3); return false;"><i class="bi bi-play-circle text-success me-1"></i> ${isMangaItem(item) ? '已在讀' : '已在看'}</a></li>

                                    <li><a class="dropdown-item" href="#" onclick="updateCardWatchStatus('${item.id}', 1); return false;"><i class="bi bi-heart text-danger me-1"></i> ${isMangaItem(item) ? '想讀' : '想看'}</a></li>

                                    <li><a class="dropdown-item" href="#" onclick="updateCardWatchStatus('${item.id}', 2); return false;"><i class="bi bi-check2-circle text-primary me-1"></i> ${isMangaItem(item) ? '已讀過' : '已看過'}</a></li>

                                </ul>

                            </div>` : ''}

                        </div>

                        <div class="btn-group btn-group-sm">

                            <button class="btn btn-outline-secondary" onclick="togglePinBookmark('${item.id}')" title="${item.pinned ? '取消置頂' : '設為置頂'}">

                                <i class="bi bi-pin-angle${item.pinned ? '-fill text-warning' : ''}"></i>

                            </button>

                            <button class="btn btn-outline-secondary" onclick="editBookmark('${item.id}')" title="編輯此收藏">

                                <i class="bi bi-pencil-square"></i>

                            </button>

                            <button class="btn btn-outline-danger" onclick="deleteBookmark('${item.id}')" title="刪除此收藏">

                                <i class="bi bi-trash3"></i>

                            </button>

                        </div>

                    </div>

                </div>

            </div>

        `;

        container.appendChild(col);

    });

    // GSAP 3 物理交錯彈入動畫 (Stagger In & Smooth Damping)

    if (!skipAnimation && typeof gsap !== 'undefined') {

        const isList = state.viewMode === "list";

        if (isList) {

            gsap.fromTo("#bookmarkContainer .bookmark-card", 

                { x: -30, opacity: 0 },

                { 

                    x: 0, 

                    opacity: 1, 

                    duration: 0.32, 

                    stagger: 0.025, 

                    ease: "power2.out", 

                    clearProps: "transform,opacity" 

                }

            );

        } else {

            gsap.fromTo("#bookmarkContainer .bookmark-card", 

                { y: 22, opacity: 0, scale: 0.96 },

                { 

                    y: 0, 

                    opacity: 1, 

                    scale: 1, 

                    duration: 0.38, 

                    stagger: 0.03, 

                    ease: "back.out(1.3)", 

                    clearProps: "transform,opacity" 

                }

            );

        }

    }

}

// ==========================================

// 圖片大圖檢視器 (Lightbox Image Preview)

// ==========================================

window.openImagePreview = function(imgSrc, title = '圖片預覽') {

    if (!imgSrc) return;

    const modalEl = document.getElementById('imagePreviewModal');

    if (!modalEl) return;

    const imgEl = document.getElementById('imagePreviewImg');

    const titleEl = document.getElementById('imagePreviewTitle');

    const openTabBtn = document.getElementById('imagePreviewOpenTabBtn');

    

    if (imgEl) imgEl.src = imgSrc;

    if (titleEl) titleEl.textContent = title || "圖片預覽";

    if (openTabBtn) openTabBtn.href = imgSrc;

    

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    modal.show();

    if (typeof gsap !== 'undefined') {

        gsap.fromTo("#imagePreviewImg", 

            { scale: 0.88, opacity: 0 }, 

            { scale: 1, opacity: 1, duration: 0.28, ease: "back.out(1.4)" }

        );

    }

};

// ==========================================

// 5. 使用者互動事件 (Actions & Events)

// ==========================================

function setupEventListeners() {

    // 1. 分類導航點擊

    const categoryNav = document.getElementById("categoryNav");

    categoryNav.querySelectorAll(".nav-link").forEach(link => {

        link.addEventListener("click", e => {

            e.preventDefault();

            categoryNav.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));

            link.classList.add("active");

            state.activeCategory = link.getAttribute("data-category");

            renderBookmarks();

        });

    });

    // 2. 搜尋框輸入 (增強 Autofill 隔離與防護)

    const searchInput = document.getElementById("searchInput");

    const clearSearchBtn = document.getElementById("clearSearchBtn");

    if (searchInput) {

        searchInput.addEventListener("input", e => {

            const val = e.target.value;

            const currentU = (state.currentUser || "").toLowerCase().trim();

            // 若剛觸發 input 時值恰為帳號名 (瀏覽器 Autofill 誤填)，清空並忽略

            if (val && currentU && val.toLowerCase().trim() === currentU) {

                searchInput.value = "";

                state.searchQuery = "";

                if (clearSearchBtn) clearSearchBtn.classList.add("d-none");

                renderBookmarks();

                return;

            }

            state.searchQuery = val;

            if (state.searchQuery.trim() !== "") {

                if (clearSearchBtn) clearSearchBtn.classList.remove("d-none");

            } else {

                if (clearSearchBtn) clearSearchBtn.classList.add("d-none");

            }

            renderBookmarks();

        });

        if (clearSearchBtn) {

            clearSearchBtn.addEventListener("click", () => {

                searchInput.value = "";

                state.searchQuery = "";

                clearSearchBtn.classList.add("d-none");

                renderBookmarks();

                searchInput.focus();

            });

        }

    }

    // 按 '/' 快捷鍵聚焦搜尋框

    window.addEventListener("keydown", e => {

        if (e.key === "/" && document.activeElement !== searchInput && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {

            e.preventDefault();

            searchInput.focus();

        }

    });

    // 3. 排序切換

    document.getElementById("sortSelect").addEventListener("change", e => {

        state.sortMode = e.target.value;

        renderBookmarks();

    });

    // 4. 視圖切換 (卡片 / 清單，支援 localStorage 持久化儲存與重整自動還原)

    const gridBtn = document.getElementById("viewGridBtn");

    const listBtn = document.getElementById("viewListBtn");

    if (gridBtn && listBtn) {

        // 依照持久化狀態初始化按鈕外觀與 body class

        if (state.viewMode === "list") {

            listBtn.classList.add("active");

            gridBtn.classList.remove("active");

            document.body.classList.add("list-view-mode");

        } else {

            gridBtn.classList.add("active");

            listBtn.classList.remove("active");

            document.body.classList.remove("list-view-mode");

        }

        // 帶有 GSAP 容器無縫轉場效果的視圖切換器 (徹底杜絕卡頓與跑版破格)

        let isSwitchingView = false;

        const switchViewWithAnimation = (targetMode) => {

            if (state.viewMode === targetMode || isSwitchingView) return;

            isSwitchingView = true;

            const container = document.getElementById("bookmarkContainer");

            // 1. 立即更新按鈕狀態 (給予使用者即時點擊反饋)

            if (targetMode === "list") {

                listBtn.classList.add("active");

                gridBtn.classList.remove("active");

            } else {

                gridBtn.classList.add("active");

                listBtn.classList.remove("active");

            }

            if (typeof gsap !== 'undefined' && container && container.children.length > 0) {

                // 2. 容器快速平滑淡出 (0.12s 毫無卡頓)

                gsap.to(container, {

                    opacity: 0,

                    y: targetMode === "list" ? -8 : 8,

                    duration: 0.12,

                    ease: "power2.in",

                    onComplete: () => {

                        // 3. 在完全隱形狀態下切換模式，絕不破版！

                        state.viewMode = targetMode;

                        localStorage.setItem("web_library_view_mode", targetMode);

                        if (targetMode === "list") {

                            document.body.classList.add("list-view-mode");

                        } else {

                            document.body.classList.remove("list-view-mode");

                        }

                        // 4. 重繪新版面

                        renderBookmarks(true);

                        // 5. 容器流暢滑入進場 (0.2s 絲滑銜接)

                        gsap.fromTo(container,

                            { opacity: 0, y: targetMode === "list" ? 8 : -8 },

                            {

                                opacity: 1,

                                y: 0,

                                duration: 0.22,

                                ease: "power2.out",

                                clearProps: "all",

                                onComplete: () => {

                                    isSwitchingView = false;

                                }

                            }

                        );

                    }

                });

            } else {

                state.viewMode = targetMode;

                localStorage.setItem("web_library_view_mode", targetMode);

                if (targetMode === "list") {

                    document.body.classList.add("list-view-mode");

                } else {

                    document.body.classList.remove("list-view-mode");

                }

                renderBookmarks();

                isSwitchingView = false;

            }

        };

        gridBtn.addEventListener("click", () => switchViewWithAnimation("grid"));

        listBtn.addEventListener("click", () => switchViewWithAnimation("list"));

    }

    // 5. 新增 / 編輯表單送出

    const bookmarkForm = document.getElementById("bookmarkForm");

    bookmarkForm.addEventListener("submit", e => {

        e.preventDefault();

        saveBookmarkFromForm();

    });

    // 智慧辨識按鈕

    document.getElementById("autoDetectBtn").addEventListener("click", () => {

        const urlInput = document.getElementById("bmUrl").value.trim();

        if (!urlInput) {

            showToast("請先輸入網址以進行辨識！", "bi-exclamation-triangle-fill text-warning");

            return;

        }

        autoDetectUrl(urlInput);

    });

    // 重置 Modal

    document.getElementById("openAddModalBtn").addEventListener("click", () => {

        document.getElementById("bookmarkForm").reset();

        document.getElementById("editBookmarkId").value = "";

        document.getElementById("bookmarkModalLabel").innerHTML = `<i class="bi bi-bookmark-plus-fill text-primary"></i> <span>新增網頁收藏</span>`;

    });

    // 6. 複製 Token 按鈕

    document.getElementById("copyTokenBtn").addEventListener("click", () => {

        navigator.clipboard.writeText(state.apiToken).then(() => {

            showToast("API Token 已複製到剪貼簿！", "bi-clipboard-check text-success");

        });

    });

    // 下載 / 檢視 Userscript 腳本

    document.getElementById("downloadUserscriptBtn").addEventListener("click", () => {

        window.open("tampermonkey/web-library.user.js", "_blank");

    });

    // 7. 模擬篡改猴採集

    document.getElementById("testScriptSimBtn").addEventListener("click", () => {

        simulateTampermonkeyCollect();

    });

    // 8. 匯出 JSON

    document.getElementById("exportDataBtn").addEventListener("click", e => {

        e.preventDefault();

        exportDataAsJSON();

    });

    // 9. 重置清空帳號書籤資料

    const resetBtn = document.getElementById("resetDemoBtn");

    if (resetBtn) {

        resetBtn.addEventListener("click", async e => {

            e.preventDefault();

            const user = state.currentUser;

            if (!user || user === "訪客") {

                showToast("訪客帳號無需重置", "bi-info-circle text-info");

                return;

            }

            if (confirm(`⚠️ 確定要清空當前帳號【${user}】的所有收藏書籤嗎？\n\n• 本機與伺服器端將同步清空（0 筆）。\n• 絕不會重新載入任何範例書籤！\n• 此操作無法復原。\n\n點擊「確定」執行清空。`)) {

                _isLocalMutationActive = true;

                state.bookmarks = [];

                state.selectedBookmarkIds.clear();

                // 1. 本地儲存立即清空

                localStorage.setItem("web_library_bookmarks", JSON.stringify([]));

                // 2. 伺服器端同步清空

                try {

                    await fetch('/api/user/clear', {

                        method: 'POST',

                        headers: { 'Content-Type': 'application/json' },

                        body: JSON.stringify({ user: user })

                    });

                } catch (err) {

                    console.warn("向伺服器發送清空指令失敗:", err);

                }

                updateUI();

                showToast(`已成功清空帳號【${user}】的所有書籤！`, "bi-trash3-fill text-success");

                // 鎖定 3 秒，徹底防範 confirm 關閉引起的 focus 事件誤拉取舊書籤競態

                setTimeout(() => {

                    _isLocalMutationActive = false;

                }, 3000);

            }

        });

    }

    // 10. 會員登入 / 註冊切換模擬 (完整支援多帳號隔離與切換專屬書庫)

    document.getElementById("loginForm").addEventListener("submit", async e => {

        e.preventDefault();

        const username = document.getElementById("loginUsername").value.trim();

        if (username) {

            state.currentUser = username;

            localStorage.setItem("web_library_user", username);

            const modalEl = document.getElementById("authModal");

            if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();

            showToast(`正在切換至【${username}】的個人書庫...`, "bi-person-check text-primary");

            // 立即從伺服器拉取該帳號的專屬書庫

            await syncFromServer(username, false);

            updateUI();

            showToast(`歡迎回來，${username}！已成功載入個人專屬收藏。`, "bi-check-circle-fill text-success");

        }

    });

    document.getElementById("registerForm").addEventListener("submit", async e => {

        e.preventDefault();

        const username = document.getElementById("regUsername").value.trim();

        if (username) {

            state.currentUser = username;

            state.apiToken = "usr_tok_" + Math.random().toString(36).substring(2, 12);

            localStorage.setItem("web_library_user", username);

            localStorage.setItem("web_library_token", state.apiToken);

            const modalEl = document.getElementById("authModal");

            if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();

            // 新註冊帳號：初始化獨立個人書庫並即時同步至伺服器

            state.bookmarks = [];

            saveToStorage(true);

            updateUI();

            showToast(`帳號 ${username} 註冊成功！已建立專屬獨立書庫。`, "bi-check-circle-fill text-success");

        }

    });

}

// ==========================================

// 6. 收藏 CRUD 核心函式

// ==========================================

// 跳轉連結並累計計數

window.jumpToBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    item.clicks = (item.clicks || 0) + 1;

    item.lastVisited = new Date().toISOString();

    saveToStorage();

    renderBookmarks();

    window.open(item.url, "_blank", "noopener,noreferrer");

};

// 置頂切換

window.togglePinBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    item.pinned = !item.pinned;

    saveToStorage();

    renderBookmarks();

    showToast(item.pinned ? "已將網頁設為置頂！" : "已取消置頂", "bi-pin-angle text-warning");

};

// 編輯開啟 Modal

window.editBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    document.getElementById("editBookmarkId").value = item.id;

    document.getElementById("bmUrl").value = item.url;

    document.getElementById("bmTitle").value = item.title;

    document.getElementById("bmCategory").value = item.category;

    document.getElementById("bmTags").value = (item.tags || []).join(", ");

    document.getElementById("bmCover").value = item.cover || "";

    document.getElementById("bmDesc").value = item.desc || "";

    document.getElementById("bmPinned").checked = !!item.pinned;

    document.getElementById("bookmarkModalLabel").innerHTML = `<i class="bi bi-pencil-fill text-primary"></i> <span>編輯網頁收藏</span>`;

    

    const modal = new bootstrap.Modal(document.getElementById("bookmarkModal"));

    modal.show();

};

// 刪除

window.deleteBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    if (confirm(`確定要刪除「${item.title}」這篇收藏嗎？`)) {

        _isLocalMutationActive = true;

        state.bookmarks = state.bookmarks.filter(b => b.id !== id);

        saveToStorage(true); // 立即同步至伺服器

        updateUI();

        showToast("收藏已成功刪除", "bi-trash3 text-danger");

        // 設定 1.5 秒冷卻，避免 confirm 彈窗關閉觸發 window.focus 時誤將已被刪除的書籤重新合併

        setTimeout(() => {

            _isLocalMutationActive = false;

        }, 1500);

    }

};

// 從表單儲存 (新增或更新)

function saveBookmarkFromForm() {

    const id = document.getElementById("editBookmarkId").value;

    const url = document.getElementById("bmUrl").value.trim();

    const title = document.getElementById("bmTitle").value.trim();

    const category = document.getElementById("bmCategory").value;

    const tagsStr = document.getElementById("bmTags").value.trim();

    const cover = document.getElementById("bmCover").value.trim();

    const desc = document.getElementById("bmDesc").value.trim();

    const pinned = document.getElementById("bmPinned").checked;

    const tags = tagsStr ? tagsStr.split(/[,，\s]+/).filter(Boolean) : [];

    if (id) {

        // 更新現有項目

        const item = state.bookmarks.find(b => b.id === id);

        if (item) {

            item.url = url;

            item.title = title;

            item.category = category;

            item.tags = tags;

            item.cover = cover;

            item.desc = desc;

            item.pinned = pinned;

            item.updatedAt = new Date().toISOString();

        }

        showToast("收藏資料已更新！", "bi-check-circle-fill text-success");

    } else {

        // 新增項目

        const newBookmark = {

            id: "bm_" + Date.now(),

            title,

            url,

            category,

            tags,

            cover,

            desc,

            pinned,

            clicks: 0,

            createdAt: new Date().toISOString()

        };

        state.bookmarks.unshift(newBookmark);

        showToast("已成功收藏新網頁！", "bi-plus-circle-fill text-success");

    }

    saveToStorage();

    updateUI();

    // 關閉 Modal

    const modalEl = document.getElementById("bookmarkModal");

    const modalInstance = bootstrap.Modal.getInstance(modalEl);

    if (modalInstance) modalInstance.hide();

}

// 智慧解析網址 (自動推斷分類與預設標籤)

function autoDetectUrl(url) {

    try {

        const parsed = new URL(url);

        const host = parsed.hostname.toLowerCase();

        let guessedCategory = "web";

        let defaultTags = [];

        let guessedTitle = "";

        let guessedCover = "";

        if (host.includes("bilibili.com")) {

            guessedCategory = "video";

            defaultTags = ["Bilibili", "B站", "影音影片"];

            guessedTitle = "Bilibili 精彩影片";

        } else if (host.includes("youtube.com") || host.includes("youtu.be")) {

            guessedCategory = "video";

            defaultTags = ["YouTube", "影音串流"];

            guessedTitle = "YouTube 熱門影音";

            const ytMatch = url.match(/(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

            if (ytMatch && ytMatch[1]) {

                guessedCover = `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;

            }

        } else if (host.includes("github.com")) {

            guessedCategory = "web";

            defaultTags = ["GitHub", "開源項目", "代碼倉庫"];

            const parts = parsed.pathname.split("/").filter(Boolean);

            if (parts.length >= 2) {

                guessedTitle = `${parts[0]} / ${parts[1]} - 開源專案`;

                guessedCover = `https://opengraph.githubassets.com/1/${parts[0]}/${parts[1]}`;

            }

        } else if (host.includes("ani.gamer.com.tw") || host.includes("bangumi.tv") || host.includes("bgm.tv") || host.includes("agefans") || host.includes("7sefun") || host.includes("bimi")) {

            guessedCategory = "anime";

            defaultTags = ["動畫", "新番", "Kazumi播放"];

            guessedTitle = "動畫新番番劇";

        } else if (host.includes("dm5.com") || host.includes("copymanga")) {

            guessedCategory = "resource";

            defaultTags = ["漫畫", "ACG資源"];

            guessedTitle = "漫畫閱讀資源";

        }

        document.getElementById("bmCategory").value = guessedCategory;

        if (!document.getElementById("bmTitle").value && guessedTitle) {

            document.getElementById("bmTitle").value = guessedTitle;

        }

        if (!document.getElementById("bmTags").value && defaultTags.length > 0) {

            document.getElementById("bmTags").value = defaultTags.join(", ");

        }

        if (!document.getElementById("bmCover").value && guessedCover) {

            document.getElementById("bmCover").value = guessedCover;

        }

        const catNames = { anime: '動畫', video: '影片', resource: '資源', web: '一般網頁' };

        showToast(`已辨識網站來源：自動切換至「${catNames[guessedCategory] || '一般網頁'}」分類！`, "bi-magic text-primary");

    } catch (e) {

        showToast("請輸入有效的完整網址 (例如 https://...)", "bi-exclamation-circle text-danger");

    }

}

// 模擬篡改猴一鍵採集

function simulateTampermonkeyCollect() {

    const mockSites = [

        {

            title: "【Bilibili】2026 最新推薦動漫排行榜 TOP 10 精彩盤點",

            url: "https://www.bilibili.com/video/BV1xx411c7m9",

            category: "video",

            tags: ["B站", "新番動漫", "排行榜"],

            cover: "https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=700&q=80",

            desc: "由篡改猴油猴腳本一鍵抓取之網頁收藏。"

        },

        {

            title: "expressjs / express: 快速、無拘束、極簡的 Node.js 網頁架構",

            url: "https://github.com/expressjs/express",

            category: "web",

            tags: ["GitHub", "Node.js", "Express", "後端框架"],

            cover: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=700&q=80",

            desc: "由篡改猴一鍵採集至 Web Library 圖書館。"

        }

    ];

    const randomPick = mockSites[Math.floor(Math.random() * mockSites.length)];

    const newItem = {

        id: "bm_" + Date.now(),

        ...randomPick,

        pinned: false,

        clicks: 1,

        createdAt: new Date().toISOString()

    };

    state.bookmarks.unshift(newItem);

    saveToStorage();

    updateUI();

    // 關閉 Modal

    const tmModal = bootstrap.Modal.getInstance(document.getElementById("tampermonkeyModal"));

    if (tmModal) tmModal.hide();

    showToast(`🎯 篡改猴腳本模擬成功！已採集「${newItem.title}」`, "bi-browser-chrome text-warning");

}

// 匯出 JSON

function exportDataAsJSON() {

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.bookmarks, null, 2));

    const downloadAnchor = document.createElement("a");

    downloadAnchor.setAttribute("href", dataStr);

    downloadAnchor.setAttribute("download", `web_library_backup_${new Date().toISOString().slice(0, 10)}.json`);

    document.body.appendChild(downloadAnchor);

    downloadAnchor.click();

    downloadAnchor.remove();

    showToast("書籤備份 JSON 已開始下載！", "bi-download text-success");

}

// 浮動通知提示 (Toast)

function showToast(message, iconClass = "bi-check-circle-fill text-success") {

    const toastEl = document.getElementById("actionToast");

    const msgEl = document.getElementById("toastMessage");

    if (!toastEl || !msgEl) {

        console.log(`[WebLibrary Toast] ${message}`);

        return;

    }

    msgEl.innerHTML = `<i class="bi ${iconClass} fs-5"></i> <span>${message}</span>`;

    const toast = new bootstrap.Toast(toastEl, { delay: 3500 });

    toast.show();

}

// ==========================================

// 7. ACG 專用模組邏輯 (Kazumi / Tachimanga / Legado)

// ==========================================

// --- 0. Kazumi 播放來源規則引擎 (仿 Kazumi 原生播放來源抽屜) ---

const KAZUMI_SOURCES = [

    { id: 'AGE', name: 'AGE動漫', desc: '全網熱門番劇（第三方解析器直出）' },

    { id: 'Giri', name: 'Girigirilove (ani.girigiri)', desc: 'BT 磁力與番劇發布索引庫' },

    { id: '7sefun', name: '7sefun動漫 (外鏈)', desc: '備用源 · 受站方防護限制需另開新分頁' }

];

let kazumiState = {

    title: '',

    cover: '',

    sources: new Map(), // id -> { status: 'loading'|'done'|'empty'|'error', results: [], expanded: false, episodes: {} }

    currentEpisode: null

};

// 安全開啟動畫播放來源 (透過 bookmark ID 查詢物件，徹底解決 title 內含撇號/引號破壞 HTML onclick 的問題)

window.playAnimeBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) {

        showToast("找不到該動畫收藏資訊", "bi-exclamation-circle text-warning");

        return;

    }

    openKazumiSourceModal(item.title, item.cover || "");

};

// 安全開啟影片播放 (透過 ID)

window.playVideoBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    openKazumiPlayer(item.title, item.url);

};

// 安全開啟漫畫閱讀 (透過 ID)

window.readMangaBookmark = function(id) {

    const item = state.bookmarks.find(b => b.id === id);

    if (!item) return;

    openTachimangaReader(item.title);

};

// 從 DOM 元素安全讀取屬性開啟 Kazumi 來源

window.openKazumiFromElement = function(el) {

    const title = el.getAttribute('data-title') || '';

    const cover = el.getAttribute('data-cover') || '';

    openKazumiSourceModal(title, cover);

};

// 從 DOM 元素安全讀取屬性收藏 Bangumi

window.collectBangumiFromElement = function(el) {

    const title = el.getAttribute('data-title') || '';

    const url = el.getAttribute('data-url') || '';

    const cover = el.getAttribute('data-cover') || '';

    collectBangumiAnime(title, url, cover);

};

// 從 DOM 元素安全啟動觀看

window.watchKazumiFromElement = function(el) {

    const title = el.getAttribute('data-title') || '';

    const detailUrl = el.getAttribute('data-url') || '';

    const source = el.getAttribute('data-source') || '';

    watchKazumiAnime(title, detailUrl, source);

};

// 從來源 Modal 重新檢索番劇

window.searchKazumiFromModal = function(q) {

    if (!q || !q.trim()) return;

    openKazumiSourceModal(q.trim(), kazumiState.cover);

};

// 智能獲取備用封面（優先反查書籤庫真實封面，無符合則使用中性 SVG 海報，絕不使用無關手辦圖）

window.getFallbackAnimeCover = function(title = '', platform = '') {

    if (title && window.state && Array.isArray(window.state.bookmarks) && window.state.bookmarks.length > 0) {

        const cleanT = title.trim().toLowerCase();

        const found = window.state.bookmarks.find(b => 

            b && b.title && 

            (b.title.toLowerCase().includes(cleanT) || cleanT.includes(b.title.toLowerCase())) && 

            b.cover && !b.cover.includes('photo-1578632767115')

        );

        if (found && found.cover) return found.cover;

    }

    if (platform === 'youtube') {

        return "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' viewBox='0 0 320 180'%3E%3Crect fill='%231f2937' width='320' height='180'/%3E%3Cpath fill='%23ef4444' d='M180 90l-30-17.3v34.6z'/%3E%3Ctext x='50%25' y='80%25' fill='%239ca3af' font-family='system-ui,sans-serif' font-size='13' font-weight='bold' text-anchor='middle'%3EYouTube 影片%3C/text%3E%3C/svg%3E";

    }

    if (platform === 'bilibili') {

        return "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' viewBox='0 0 320 180'%3E%3Crect fill='%231e293b' width='320' height='180'/%3E%3Cpath fill='%2300aeec' d='M140 70h40v30h-40z'/%3E%3Ctext x='50%25' y='75%25' fill='%2300aeec' font-family='system-ui,sans-serif' font-size='14' font-weight='bold' text-anchor='middle'%3EBilibili 影片%3C/text%3E%3C/svg%3E";

    }

    return "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='450' viewBox='0 0 320 450'%3E%3Crect fill='%231e293b' width='320' height='450'/%3E%3Ccircle cx='160' cy='200' r='50' fill='%23dc2626' opacity='0.8'/%3E%3Cpolygon points='150,180 180,200 150,220' fill='%23ffffff'/%3E%3Ctext x='50%25' y='70%25' fill='%23e2e8f0' font-family='system-ui,sans-serif' font-size='18' font-weight='bold' text-anchor='middle'%3E動漫影片%3C/text%3E%3C/svg%3E";

};

window.openKazumiSourceModal = function(animeTitle = "", animeCover = "") {

    const title = (animeTitle || "").trim();

    kazumiState.title = title;

    let cover = animeCover;

    if (!cover || cover.includes('photo-1578632767115')) {

        cover = window.getFallbackAnimeCover(title, 'anime');

    }

    kazumiState.cover = cover;

    const titleEl = document.getElementById('kazumiSourceTitle');

    const coverEl = document.getElementById('kazumiSourceCover');

    const summaryEl = document.getElementById('kazumiSourceSummary');

    const kwInput = document.getElementById('kazumiModalKeywordInput');

    if (coverEl) coverEl.src = kazumiState.cover;

    if (kwInput) kwInput.value = title;

    // 若尚未取得真實封面，非同步向 Bangumi API 搜尋補全官方高清海報

    if (title && (!animeCover || animeCover.includes('photo-1578632767115'))) {

        fetch(`/api/bangumi/search?q=${encodeURIComponent(title)}&type=2`)

            .then(r => r.json())

            .then(res => {

                if (res.success && res.data && Array.isArray(res.data.data) && res.data.data.length > 0) {

                    const match = res.data.data.find(s => 

                        (s.name_cn && (s.name_cn.trim() === title || s.name_cn.includes(title) || title.includes(s.name_cn))) ||

                        (s.name && (s.name.trim() === title || s.name.includes(title) || title.includes(s.name)))

                    ) || res.data.data[0];

                    const realImg = (match.images && (match.images.large || match.images.common || match.images.medium || match.images.small)) || match.image || '';

                    if (realImg) {

                        kazumiState.cover = realImg;

                        if (coverEl) coverEl.src = realImg;

                        let hist = window.getWatchHistoryList ? window.getWatchHistoryList() : [];

                        let updated = false;

                        hist.forEach(h => {

                            if (h.platform === 'anime' && (h.title === title || h.title.includes(title) || title.includes(h.title))) {

                                if (!h.cover || h.cover.includes('photo-1578632767115') || h.cover.startsWith('data:image/svg')) {

                                    h.cover = realImg;

                                    updated = true;

                                }

                            }

                        });

                        if (updated) {

                            localStorage.setItem('web_library_watch_history', JSON.stringify(hist));

                            if (typeof window.renderAnimeHistoryStandby === 'function') window.renderAnimeHistoryStandby();

                            if (typeof window.renderWatchHistoryGrid === 'function') window.renderWatchHistoryGrid();

                        }

                    }

                }

            })

            .catch(() => {});

    }

    if (title) {

        if (titleEl) titleEl.textContent = title;

        if (summaryEl) summaryEl.textContent = `${KAZUMI_SOURCES.length} 個來源 · 正在檢索...`;

        kazumiState.sources = new Map(KAZUMI_SOURCES.map(s => [s.id, { status: 'loading', results: [], expanded: false, episodes: {} }]));

        renderSourceList();

        // 同步並發向後端請求各來源

        KAZUMI_SOURCES.forEach(s => fetchRuleSearch(s.id, title));

    } else {

        if (titleEl) titleEl.textContent = "動漫播放來源檢索";

        if (summaryEl) summaryEl.textContent = "請輸入動漫片名檢索播放來源";

        kazumiState.sources = new Map(KAZUMI_SOURCES.map(s => [s.id, { status: 'empty', results: [], expanded: false, episodes: {} }]));

        renderSourceList();

    }

    const modalEl = document.getElementById('kazumiSourceModal');

    if (modalEl) {

        bootstrap.Modal.getOrCreateInstance(modalEl).show();

    }

};

async function fetchRuleSearch(sourceId, title) {

    const state = kazumiState.sources.get(sourceId);

    if (!state) return;

    state.status = 'loading';

    renderSourceList();

    try {

        const res = await fetch(`/api/kazumi/rule-search?q=${encodeURIComponent(title)}&source=${sourceId}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        const results = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);

        state.results = results;

        state.status = results.length > 0 ? 'done' : 'empty';

        if (results.length > 0) {

            state.expanded = true; // 預設展開有結果的來源

        }

    } catch (err) {

        console.error(`來源 ${sourceId} 檢索失敗：`, err);

        state.status = 'error';

        state.results = [];

    }

    renderSourceList();

    updateSourceSummary();

}

function updateSourceSummary() {

    const summaryEl = document.getElementById('kazumiSourceSummary');

    if (!summaryEl) return;

    const total = KAZUMI_SOURCES.length;

    const loading = [...kazumiState.sources.values()].some(s => s.status === 'loading');

    const found = [...kazumiState.sources.values()].filter(s => s.status === 'done').reduce((sum, s) => sum + s.results.length, 0);

    let text = `${total} 個來源 · `;

    if (loading) text += '正在檢索...';

    else if (found > 0) text += `找到 ${found} 個作品`;

    else text += '無符合結果';

    summaryEl.textContent = text;

}

function renderSourceList() {

    const list = document.getElementById('kazumiSourceList');

    if (!list) return;

    list.innerHTML = '';

    KAZUMI_SOURCES.forEach(source => {

        const state = kazumiState.sources.get(source.id) || { status: 'loading', results: [], expanded: false };

        const card = document.createElement('div');

        card.className = 'border border-secondary rounded-3 bg-black bg-opacity-40 p-3 mb-2';

        // 來源頂部摘要列

        const header = document.createElement('div');

        header.className = 'd-flex align-items-center justify-content-between flex-wrap gap-2';

        header.style.cursor = state.status === 'done' ? 'pointer' : 'default';

        const badgeHtml = getStatusBadge(state.status, state.results.length);

        header.innerHTML = `

            <div class="d-flex align-items-center gap-2">

                <span class="fw-bold text-light">${escapeHtml(source.name)}</span>

                <small class="ms-1" style="color: #cbd5e1; font-weight: 500;">${escapeHtml(source.desc)}</small>

            </div>

            <div class="d-flex align-items-center gap-2">

                ${badgeHtml}

                ${state.status === 'done' ? `<i class="bi bi-chevron-${state.expanded ? 'up' : 'down'} text-white-50"></i>` : ''}

            </div>

        `;

        if (state.status === 'done') {

            header.onclick = () => {

                state.expanded = !state.expanded;

                renderSourceList();

            };

        }

        card.appendChild(header);

        // 展開搜尋結果列表

        if (state.expanded && state.status === 'done') {

            const resultsBox = document.createElement('div');

            resultsBox.className = 'mt-3 pt-3 border-top border-secondary d-flex flex-column gap-2';

            state.results.forEach((item, rIdx) => {

                const itemDiv = document.createElement('div');

                itemDiv.className = 'p-2 rounded-2 bg-dark bg-opacity-50 border border-secondary';

                const statusTagId = `animeBgmStatusTxt_${source.id}_${rIdx}`;

                const itemHeader = document.createElement('div');

                itemHeader.className = 'd-flex align-items-center justify-content-between flex-wrap gap-2 mb-2';

                itemHeader.innerHTML = `

                    <div class="d-flex align-items-center gap-2 text-truncate" style="max-width: 52%;">

                        <span class="badge bg-danger-subtle text-danger px-1">#${rIdx + 1}</span>

                        <span class="fw-semibold text-white small text-truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>

                    </div>

                    <div class="d-flex align-items-center gap-1 flex-wrap">

                        <button class="btn btn-xs btn-outline-success text-truncate" onclick="addAnimeSearchResultToLibrary('${escapeHtml(item.title)}', '${escapeHtml(kazumiState.cover || '')}', '${escapeHtml(item.detailUrl || '')}')" title="收藏作品至個人圖書館">

                            <i class="bi bi-bookmark-plus"></i> +收藏

                        </button>

                        <div class="dropdown d-inline-block">

                            <button class="btn btn-xs btn-outline-info dropdown-toggle d-flex align-items-center gap-1 bookmark-watch-status-btn" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="檢視或更改 Bangumi 狀態">

                                <i class="bi bi-bookmark-heart"></i> <span id="${statusTagId}">辨識中...</span>

                            </button>

                            <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end shadow-sm" style="font-size: 0.8rem; z-index: 1060;">

                                <li><h6 class="dropdown-header small" style="color: #38bdf8 !important;">Bangumi 狀態變更</h6></li>

                                <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(item.title)}', 3, false, '${statusTagId}'); return false;"><i class="bi bi-play-circle text-success me-1"></i> 已在看</a></li>

                                <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(item.title)}', 1, false, '${statusTagId}'); return false;"><i class="bi bi-heart text-danger me-1"></i> 想看</a></li>

                                <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(item.title)}', 2, false, '${statusTagId}'); return false;"><i class="bi bi-check2-circle text-primary me-1"></i> 已看過</a></li>

                            </ul>

                        </div>

                        <button class="btn btn-xs btn-outline-danger" id="epBtn_${source.id}_${rIdx}">

                            <i class="bi bi-list-ul"></i> 取得選集

                        </button>

                    </div>

                `;

                setTimeout(() => { checkAndRenderBangumiStatus(item.title, 2, statusTagId); }, 20);

                const epContainer = document.createElement('div');

                epContainer.id = `episodes_${source.id}_${rIdx}`;

                epContainer.className = 'd-flex flex-wrap gap-1 mt-2';

                const fetchEpisodesBtn = itemHeader.querySelector(`#epBtn_${source.id}_${rIdx}`);

                fetchEpisodesBtn.onclick = (e) => {

                    e.stopPropagation();

                    loadEpisodesForSource(source.id, rIdx, item, epContainer, fetchEpisodesBtn);

                };

                // 自動為第一個搜尋結果載入選集，體驗極佳！

                if (rIdx === 0 && (!state.episodes || !state.episodes[rIdx])) {

                    setTimeout(() => {

                        loadEpisodesForSource(source.id, rIdx, item, epContainer, fetchEpisodesBtn);

                    }, 50);

                } else if (state.episodes && state.episodes[rIdx]) {

                    renderEpisodeButtons(source.id, item, state.episodes[rIdx], epContainer);

                    fetchEpisodesBtn.innerHTML = `<i class="bi bi-check-circle"></i> 共 ${state.episodes[rIdx].length} 集`;

                }

                itemDiv.appendChild(itemHeader);

                itemDiv.appendChild(epContainer);

                resultsBox.appendChild(itemDiv);

            });

            card.appendChild(resultsBox);

        }

        list.appendChild(card);

    });

}

function getStatusBadge(status, count) {

    switch(status) {

        case 'loading':

            return `<span class="badge bg-secondary"><span class="spinner-border spinner-border-sm me-1" style="width:0.75rem;height:0.75rem;"></span>檢索中...</span>`;

        case 'done':

            return `<span class="badge bg-success">找到 ${count} 個作品</span>`;

        case 'empty':

            return `<span class="badge border text-white-50" style="background-color: rgba(255, 255, 255, 0.15); border-color: rgba(255, 255, 255, 0.25);">無符合結果</span>`;

        case 'error':

            return `<span class="badge bg-danger">來源連線異常</span>`;

        default:

            return '';

    }

}

async function loadEpisodesForSource(sourceId, rIdx, item, epContainer, btn) {

    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>解析劇集...`;

    btn.disabled = true;

    try {

        const res = await fetch(`/api/kazumi/rule-episodes?detailUrl=${encodeURIComponent(item.detailUrl)}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        const eps = Array.isArray(data.episodes) ? data.episodes : [];

        const state = kazumiState.sources.get(sourceId);

        if (state) {

            if (!state.episodes) state.episodes = {};

            state.episodes[rIdx] = eps;

        }

        renderEpisodeButtons(sourceId, item, eps, epContainer);

        btn.innerHTML = `<i class="bi bi-check-circle"></i> 共 ${eps.length} 集`;

    } catch (err) {

        console.error('載入劇集失敗：', err);

        epContainer.innerHTML = `<div class="text-danger small p-2"><i class="bi bi-exclamation-triangle"></i> 解析選集失敗，請重試</div>`;

        btn.disabled = false;

        btn.innerHTML = `<i class="bi bi-arrow-repeat"></i> 重試`;

    }

}

function renderEpisodeButtons(sourceId, animeItem, episodes, container) {

    container.innerHTML = '';

    if (!episodes || episodes.length === 0) {

        container.innerHTML = `<div class="text-secondary small p-2">暫無可用選集</div>`;

        return;

    }

    // 前端防護：依集數名稱去重，避免多線路重複顯示

    const seenTitles = new Set();

    const uniqueEpisodes = [];

    episodes.forEach(ep => {

        const key = (ep.title || '').trim();

        if (!seenTitles.has(key)) {

            seenTitles.add(key);

            uniqueEpisodes.push(ep);

        }

    });

    const isExpanded = container.getAttribute('data-expanded') === 'true';

    const displayEps = (isExpanded || uniqueEpisodes.length <= 48) ? uniqueEpisodes : uniqueEpisodes.slice(0, 48);

    displayEps.forEach((ep, idx) => {

        const epBtn = document.createElement('button');

        epBtn.className = 'btn btn-xs btn-outline-light text-truncate';

        epBtn.style.minWidth = '68px';

        epBtn.textContent = ep.title || `第${idx + 1}話`;

        epBtn.title = ep.title;

        epBtn.onclick = () => playRuleEpisode(sourceId, animeItem, ep, uniqueEpisodes);

        container.appendChild(epBtn);

    });

    if (uniqueEpisodes.length > 48) {

        if (!isExpanded) {

            const moreBtn = document.createElement('button');

            moreBtn.type = 'button';

            moreBtn.className = 'btn btn-xs btn-outline-info align-self-center text-truncate';

            moreBtn.innerHTML = `<i class="bi bi-chevron-double-down"></i> + 尚有 ${uniqueEpisodes.length - 48} 集 (點擊展開)`;

            moreBtn.title = "點擊展開全部集數清單";

            moreBtn.onclick = (e) => {

                e.stopPropagation();

                container.setAttribute('data-expanded', 'true');

                renderEpisodeButtons(sourceId, animeItem, episodes, container);

            };

            container.appendChild(moreBtn);

        } else {

            const collapseBtn = document.createElement('button');

            collapseBtn.type = 'button';

            collapseBtn.className = 'btn btn-xs btn-outline-secondary align-self-center text-truncate';

            collapseBtn.innerHTML = `<i class="bi bi-chevron-double-up"></i> 收起多餘集數`;

            collapseBtn.onclick = (e) => {

                e.stopPropagation();

                container.setAttribute('data-expanded', 'false');

                renderEpisodeButtons(sourceId, animeItem, episodes, container);

            };

            container.appendChild(collapseBtn);

        }

    }

}

async function playRuleEpisode(sourceId, animeItem, episode, allEpisodes) {

    showToast(`正在透過 Kazumi Rules 解析「${animeItem.title} - ${episode.title}」...`, "bi-broadcast text-danger");

    try {

        const res = await fetch(`/api/kazumi/rule-play?playUrl=${encodeURIComponent(episode.playUrl)}`);

        const data = await res.json();

        if (data.success && data.playerUrl) {

            const sourceModal = bootstrap.Modal.getInstance(document.getElementById('kazumiSourceModal'));

            if (sourceModal) sourceModal.hide();

            const epData = { ...episode, isBlockedIframe: data.isBlockedIframe, isDirectStream: data.isDirectStream };

            const animeCover = (animeItem && animeItem.cover) || kazumiState.cover || '';

            openTheaterWithUrl(animeItem.title, episode.title, data.playerUrl, allEpisodes, epData, animeCover);

            // 自動雙向回寫 Bangumi 觀看進度 (若綁定 Token 且為 Bangumi 作品)

            try {

                const token = window.getBangumiToken ? window.getBangumiToken() : null;

                if (token) {

                    let subjId = null;

                    if (animeItem && animeItem.url && /bgm\.tv\/subject\/(\d+)/.test(animeItem.url)) {

                        subjId = animeItem.url.match(/bgm\.tv\/subject\/(\d+)/)[1];

                    } else if (animeItem && animeItem.title) {

                        const matched = state.bookmarks.find(b => 

                            (b.title === animeItem.title || (b.title && b.title.includes(animeItem.title))) &&

                            b.url && /bgm\.tv\/subject\/(\d+)/.test(b.url)

                        );

                        if (matched) subjId = matched.url.match(/bgm\.tv\/subject\/(\d+)/)[1];

                    }

                    if (subjId) {

                        const epMatch = (episode.title || '').match(/(?:第\s*(\d+)\s*[話集]|(\d+))/);

                        const epNum = epMatch ? parseInt(epMatch[1] || epMatch[2], 10) : null;

                        if (epNum) {

                            window.syncEpisodeProgressToBangumi(subjId, null, epNum);

                        }

                    }

                }

            } catch (syncErr) {

                console.warn('[Bangumi Sync Progress] 忽略非致命錯誤:', syncErr);

            }

        } else {

            throw new Error(data.error || '解析播放器網址失敗');

        }

    } catch (err) {

        console.error('播放失敗：', err);

        showToast(`解析「${episode.title}」失敗：${err.message}`, "bi-exclamation-octagon text-danger");

    }

}

function openTheaterWithUrl(animeTitle, epTitle, playerUrl, allEpisodes = [], currentEp = null, animeCover = '') {

    window.currentKazumiPlayingUrl = playerUrl;

    window.currentKazumiAnimeTitle = animeTitle;

    window.currentKazumiEpTitle = epTitle;

    if (animeCover) kazumiState.cover = animeCover;

    const coverToSave = animeCover || kazumiState.cover || (window.getFallbackAnimeCover ? window.getFallbackAnimeCover(animeTitle, 'anime') : '');

    if (typeof window.saveAnimePlayHistory === 'function') {

        window.saveAnimePlayHistory(animeTitle, coverToSave, epTitle, playerUrl, 0, 0);

    }

    const modalTitle = document.getElementById("animePlayerTitle");

    const isDirectVideo = /\.(mp4|m3u8)(\?.*)?$/i.test(playerUrl) || playerUrl.includes('.mp4') || playerUrl.includes('.m3u8') || (currentEp && currentEp.isDirectStream);

    const isBlocked = (currentEp && currentEp.isBlockedIframe) || (playerUrl && playerUrl.includes('lmm85.com') && !playerUrl.includes('dp.no3acg.com'));

    

    if (modalTitle) {

        modalTitle.innerHTML = `${escapeHtml(animeTitle)} - ${escapeHtml(epTitle)} ` +

            (isBlocked 

                ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle ms-2" style="font-size: 0.72rem;" title="此來源設有防內嵌保護，請於新分頁觀看"><i class="bi bi-shield-lock-fill"></i> 防內嵌保護</span>`

                : isDirectVideo 

                    ? `<span class="badge bg-success-subtle text-success border border-success-subtle ms-2" style="font-size: 0.72rem;" title="原生播放器：支援畫面直接點擊暫停/播放與進度條雙向同步"><i class="bi bi-play-circle-fill"></i> 原生同步</span>` 

                    : `<span class="badge bg-secondary-subtle text-secondary border ms-2" style="font-size: 0.72rem;" title="內嵌播放器：受跨域安全限制，請用【空白鍵 Space】或下方控制條進行同步"><i class="bi bi-window"></i> 內嵌模式</span>`);

    }

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

    const placeholder = document.getElementById("kazumiTheaterPlaceholder");

    const fallbackCard = document.getElementById("kazumiBlockedFallback");

    if (placeholder) placeholder.style.display = "none";

    const histBox = document.getElementById("animeRecentHistoryBox");

    if (histBox) histBox.style.display = "none";

    const listContainer = document.querySelector(".episode-list-container");

    if (listContainer) listContainer.style.display = "flex";

    const screenCont = document.getElementById("kazumiScreenContainer");

    if (screenCont) {

        screenCont.classList.remove("is-standby");

        if (typeof startFsIdleTimer === 'function') startFsIdleTimer();

    }

    // 處理受 SAMEORIGIN 阻擋之線路（如 lmm85 封鎖）

    if (isBlocked) {

        if (screenCont) screenCont.classList.add("has-blocked-fallback");

        if (window.kazumiHlsInstance) {

            window.kazumiHlsInstance.destroy();

            window.kazumiHlsInstance = null;

        }

        if (video) { video.pause(); video.style.display = "none"; }

        if (iframeWrapper) iframeWrapper.style.display = "none";

        if (iframe) { iframe.src = ""; iframe.style.display = "none"; }

        if (fallbackCard) {

            fallbackCard.style.display = "block";

            const openBtn = document.getElementById("kazumiBlockedOpenTabBtn");

            if (openBtn) openBtn.href = playerUrl;

        }

        showToast("💡 此集來源因站方安全保護無法直接內嵌，請點擊中央【新分頁播放】或切換其他源！", "bi-info-circle-fill text-warning");

    } else if (isDirectVideo) {

        if (screenCont) screenCont.classList.remove("has-blocked-fallback");

        if (fallbackCard) fallbackCard.style.display = "none";

        if (iframeWrapper) iframeWrapper.style.display = "none";

        if (iframe) { iframe.src = ""; iframe.style.display = "none"; }

        if (video) {

            video.style.display = "block";

            video.controls = false;

            video.removeAttribute("controls");

            if (playerUrl.includes('.m3u8')) {

                if (window.Hls && Hls.isSupported()) {

                    if (window.kazumiHlsInstance) {

                        window.kazumiHlsInstance.destroy();

                    }

                    const hls = new Hls({ enableWorker: true });

                    hls.loadSource(playerUrl);

                    hls.attachMedia(video);

                    window.kazumiHlsInstance = hls;

                    hls.on(Hls.Events.MANIFEST_PARSED, function() {

                        video.play().catch(() => {});

                    });

                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {

                    video.src = playerUrl;

                    video.currentTime = 0;

                    video.play().catch(() => {});

                } else {

                    video.src = playerUrl;

                    video.currentTime = 0;

                    video.play().catch(() => {});

                }

            } else {

                if (window.kazumiHlsInstance) {

                    window.kazumiHlsInstance.destroy();

                    window.kazumiHlsInstance = null;

                }

                video.src = playerUrl;

                video.currentTime = 0;

                video.play().catch(() => {});

            }

        }

    } else {

        if (window.kazumiHlsInstance) {

            window.kazumiHlsInstance.destroy();

            window.kazumiHlsInstance = null;

        }

        if (video) { video.pause(); video.style.display = "none"; }

        if (fallbackCard) fallbackCard.style.display = "none";

        if (iframeWrapper) {

            iframeWrapper.style.display = "block";

            if (playerUrl && playerUrl.includes('bilibili')) {

                iframeWrapper.classList.add("is-bilibili");

                iframeWrapper.classList.remove("is-pure-anime");

            } else if (playerUrl && !playerUrl.includes('youtube')) {

                iframeWrapper.classList.remove("is-bilibili");

                iframeWrapper.classList.add("is-pure-anime");

            } else {

                iframeWrapper.classList.remove("is-bilibili");

                iframeWrapper.classList.remove("is-pure-anime");

            }

        }

        if (iframe) {

            iframe.style.display = "block";

            iframe.src = playerUrl;

        }

    }

    // 注入動漫劇院右側選集抽屜 (進行集數防重保護)

    if (listContainer && allEpisodes.length > 0) {

        listContainer.innerHTML = "";

        const seen = new Set();

        const uniqueEps = [];

        allEpisodes.forEach(ep => {

            const key = (ep.title || '').trim();

            if (!seen.has(key)) {

                seen.add(key);

                uniqueEps.push(ep);

            }

        });

        uniqueEps.forEach((ep) => {

            const isActive = currentEp && currentEp.playUrl === ep.playUrl;

            const btn = document.createElement("button");

            btn.className = `btn btn-sm ${isActive ? 'btn-primary active' : 'btn-outline-secondary'} ep-btn text-truncate text-start w-100 mb-1`;

            btn.style.width = "100%";

            btn.title = ep.title;

            btn.innerHTML = `<i class="bi bi-play-fill"></i> ${escapeHtml(ep.title)}`;

            btn.onclick = () => {

                playRuleEpisode('', { title: animeTitle, cover: coverToSave }, ep, uniqueEps);

            };

            listContainer.appendChild(btn);

        });

    }

    // 啟動彈幕流

    const epMatch = (epTitle || '').match(/\d+/);

    const epNo = epMatch ? parseInt(epMatch[0], 10) : 1;

    startDanmakuStream(animeTitle, null, epNo);

    const theaterModal = bootstrap.Modal.getOrCreateInstance(document.getElementById("animePlayerModal"));

    theaterModal.show();

    setTimeout(() => {

        if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

    }, 100);

}

// 劇院內一鍵搜尋番劇（支援待命畫面與 Header 搜尋，具備 Bootstrap 5 模態框異步防衝突機制）

window.searchAnimeFromTheater = function(keyword) {

    let term = keyword;

    if (!term || typeof term !== 'string') {

        const standbyInput = document.getElementById('theaterStandbySearchInput');

        const headerInput = document.getElementById('theaterHeaderSearchInput');

        term = (standbyInput && standbyInput.value.trim()) || (headerInput && headerInput.value.trim()) || '';

    }

    term = term.trim();

    if (!term) {

        showToast('請輸入動漫片名進行搜尋！', 'bi-info-circle text-info');

        return;

    }

    const theaterModalEl = document.getElementById('animePlayerModal');

    const isShown = theaterModalEl && (theaterModalEl.classList.contains('show') || theaterModalEl.style.display === 'block');

    if (isShown) {

        const theaterModal = bootstrap.Modal.getInstance(theaterModalEl) || bootstrap.Modal.getOrCreateInstance(theaterModalEl);

        // 等待劇院關閉過渡動畫完全結束，避免 Bootstrap 多重 Modal 衝突與 Backdrop 閃退問題

        const onHidden = function() {

            theaterModalEl.removeEventListener('hidden.bs.modal', onHidden);

            setTimeout(() => {

                openKazumiSourceModal(term);

            }, 60);

        };

        theaterModalEl.addEventListener('hidden.bs.modal', onHidden);

        theaterModal.hide();

    } else {

        openKazumiSourceModal(term);

    }

};

// 重置動漫劇院為純淨黑底空白待命狀態

window.resetKazumiTheater = function() {

    if (window.kazumiHlsInstance) {

        window.kazumiHlsInstance.destroy();

        window.kazumiHlsInstance = null;

    }

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

    const placeholder = document.getElementById("kazumiTheaterPlaceholder");

    const fallback = document.getElementById("kazumiBlockedFallback");

    const titleEl = document.getElementById("animePlayerTitle");

    const listContainer = document.querySelector(".episode-list-container");

    const standbyInput = document.getElementById("theaterStandbySearchInput");

    const headerInput = document.getElementById("theaterHeaderSearchInput");

    if (standbyInput) standbyInput.value = "";

    if (headerInput) headerInput.value = "";

    if (fallback) fallback.style.display = "none";

    if (video) {

        video.pause();

        video.removeAttribute("src");

        video.load();

        video.style.display = "none";

        video.controls = false;

        video.removeAttribute("controls");

    }

    if (iframeWrapper) iframeWrapper.style.display = "none";

    if (iframe) {

        iframe.src = "";

        iframe.style.display = "none";

    }

    if (placeholder) {

        placeholder.style.display = "block";

    }

    const histBox = document.getElementById("animeRecentHistoryBox");

    if (histBox) {

        histBox.style.display = "flex";

        if (typeof window.renderAnimeHistoryStandby === 'function') {

            window.renderAnimeHistoryStandby();

        }

    }

    if (titleEl) {

        titleEl.textContent = "動漫劇院播放器（待命狀態）";

    }

    const container = document.getElementById("kazumiScreenContainer");

    if (container) {

        container.classList.add("is-standby");

        container.classList.remove("fs-controls-hidden");

    }

    if (listContainer) {

        listContainer.style.display = "none";

        listContainer.innerHTML = '<div class="text-secondary small p-3 text-center w-100" id="kazumiEpisodePlaceholder">請先由來源清單選擇集數開播</div>';

    }

    if (typeof window.clearAllDanmakuState === 'function') {

        window.clearAllDanmakuState();

    }

};

// --- A. Kazumi 動漫劇院播放器 ---

let danmakuInterval = null;

let danmakuEnabled = false; // 彈幕預設關閉

window.openKazumiPlayer = function(title = "", src = "") {

    // 若無提供直接串流/外嵌網址，一律跳出播放來源檢索抽屜

    if (!src || src === "" || src.includes("bgm.tv") || (!src.includes("bilibili") && !src.includes("youtube") && !src.includes("youtu.be") && !src.includes(".mp4") && !src.includes(".m3u8"))) {

        if (title && title.trim()) {

            return openKazumiSourceModal(title);

        }

        // 純空白待命狀態開啟

        resetKazumiTheater();

        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("animePlayerModal"));

        modal.show();

        return;

    }

    window.currentKazumiPlayingUrl = src;

    window.currentKazumiAnimeTitle = title;

    document.getElementById("animePlayerTitle").textContent = title;

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

    const placeholder = document.getElementById("kazumiTheaterPlaceholder");

    if (placeholder) placeholder.style.display = "none";

    const histBox = document.getElementById("animeRecentHistoryBox");

    if (histBox) histBox.style.display = "none";

    const listContainer = document.querySelector(".episode-list-container");

    if (listContainer) listContainer.style.display = "flex";

    const screenCont = document.getElementById("kazumiScreenContainer");

    if (screenCont) {

        screenCont.classList.remove("is-standby");

        if (typeof startFsIdleTimer === 'function') startFsIdleTimer();

    }

    // 辨識是否為 Bilibili 影片 (支援 BV號、av號、番劇 ss/ep 或一般網址)

    const biliMatch = src.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/i) || 

                      src.match(/(BV[a-zA-Z0-9]{10})/i) || 

                      src.match(/bilibili\.com\/bangumi\/play\/(ss\d+|ep\d+)/i) ||

                      (src.includes('bilibili.com') && !src.includes('live.bilibili'));

    // 辨識是否為 YouTube 影片

    const ytMatch = src.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

    if (biliMatch) {

        // Bilibili 播放處理：優先請求官方原生 MP4 串流，消除 iframe 裁切黑邊，支援原生音量與進度控制！

        const bvid = (biliMatch[1] && biliMatch[1].startsWith('BV')) ? biliMatch[1] : '';

        const playUrlApi = `/api/kazumi/bilibili-playurl?bvid=${encodeURIComponent(bvid)}&url=${encodeURIComponent(src)}`;

        // 即刻儲存觀看歷史 (使用台灣用語「影片」)

        if (typeof window.saveWatchHistory === 'function') {

            window.saveWatchHistory(title, '', 'Bilibili 影片', src, 0, 0, 'bilibili');

        }

        fetch(playUrlApi)

            .then(r => r.json())

            .then(res => {

                if (res.success && res.isDirectStream && res.streamUrl) {

                    if (iframeWrapper) iframeWrapper.style.display = "none";

                    if (iframe) { iframe.src = ""; iframe.style.display = "none"; }

                    video.style.display = "block";

                    video.controls = false;

                    video.removeAttribute("controls");

                    video.src = res.streamUrl;

                    video.currentTime = 0;

                    

                    // 即刻同步音量狀態

                    if (typeof window.applyKazumiVolume === 'function') {

                        window.applyKazumiVolume(false);

                    }

                    video.addEventListener('loadedmetadata', () => {

                        if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

                    }, { once: true });

                    video.play().catch(() => {});

                    showToast("🎉 已成功取得 Bilibili 原生高畫質串流！支援完美原生音量與進度控制！", "bi-play-circle-fill text-success");

                } else {

                    video.pause();

                    video.style.display = "none";

                    if (iframeWrapper) {

                        iframeWrapper.style.display = "block";

                        iframeWrapper.classList.add("is-bilibili");

                    }

                    iframe.style.display = "block";

                    const fallbackUrl = res.fallbackIframeUrl || `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid || 'BV1xx411c7m9')}&page=1&high_quality=1&as_wide=1&danmaku=0`;

                    iframe.src = fallbackUrl;

                    setTimeout(() => {

                        if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

                    }, 200);

                    showToast("已載入 Bilibili 外嵌播放器！", "bi-info-circle text-warning");

                }

            })

            .catch(() => {

                video.pause();

                video.style.display = "none";

                if (iframeWrapper) {

                    iframeWrapper.style.display = "block";

                    iframeWrapper.classList.add("is-bilibili");

                }

                iframe.style.display = "block";

                iframe.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid || 'BV1xx411c7m9')}&page=1&high_quality=1&as_wide=1&danmaku=0`;

                setTimeout(() => {

                    if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

                }, 200);

            });

        // 呼叫後端 Kazumi 模組解析真實標題、分P選集、官方高清封面與 CID (若為 BV 影片)

        if (bvid) {

            fetch(`/api/kazumi/resolve?bvid=${bvid}`)

                .then(r => r.json())

                .then(res => {

                    if (res.success && res.data) {

                        const realTitle = res.data.title || title;

                        const realCover = res.data.cover || '';

                        if (realTitle) {

                            window.currentKazumiAnimeTitle = realTitle;

                            const tEl = document.getElementById("animePlayerTitle");

                            if (tEl) tEl.textContent = realTitle;

                        }

                        if (realCover) kazumiState.cover = realCover;

                        let hist = window.getWatchHistoryList ? window.getWatchHistoryList() : [];

                        let updated = false;

                        hist.forEach(h => {

                            if (h.platform === 'bilibili' && (h.playUrl === src || (bvid && h.playUrl.includes(bvid)))) {

                                if (realTitle) h.title = realTitle;

                                if (realCover) h.cover = realCover;

                                updated = true;

                            }

                        });

                        if (updated) {

                            localStorage.setItem('web_library_watch_history', JSON.stringify(hist));

                            if (typeof window.renderAnimeHistoryStandby === 'function') window.renderAnimeHistoryStandby();

                            if (typeof window.renderWatchHistoryGrid === 'function') window.renderWatchHistoryGrid();

                        }

                        if (Array.isArray(res.data.episodes) && res.data.episodes.length > 0) {

                            renderKazumiEpisodes(bvid, res.data.episodes);

                            if (res.data.episodes[0].cid) {

                                startDanmakuStream(realTitle || title, res.data.episodes[0].cid);

                            }

                        }

                    }

                })

                .catch(() => {});

        }

    } else if (ytMatch) {

        // YouTube 官方無 Cookie 安全內嵌播放器 (純淨化：隱藏原控制項、關閉鍵盤衝突)

        const ytId = ytMatch[1];

        const ytCover = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

        if (typeof window.saveWatchHistory === 'function') {

            window.saveWatchHistory(title, ytCover, 'YouTube 影片', src, 0, 0, 'youtube');

        }

        video.pause();

        video.style.display = "none";

        if (iframeWrapper) {

            iframeWrapper.style.display = "block";

            iframeWrapper.classList.remove("is-bilibili");

        }

        iframe.style.display = "block";

        iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");

        const originParam = encodeURIComponent(window.location.origin);

        iframe.src = `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&enablejsapi=1&origin=${originParam}&widget_referrer=${originParam}&rel=0&controls=0&disablekb=1&iv_load_policy=3&modestbranding=1&playsinline=1`;

        showToast("已載入 YouTube 官方純淨內嵌劇院！", "bi-youtube text-danger");

        setTimeout(() => {

            if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

        }, 200);

    } else {

        // 原生 HTML5 影片 / 代理串流

        if (typeof window.saveWatchHistory === 'function') {

            window.saveWatchHistory(title, '', '原生串流', src, 0, 0, 'anime');

        }

        if (iframeWrapper) {

            iframeWrapper.style.display = "none";

            iframeWrapper.classList.remove("is-bilibili");

        }

        iframe.src = "";

        iframe.style.display = "none";

        video.style.display = "block";

        video.controls = false;

        video.removeAttribute("controls");

        video.src = src;

        video.currentTime = 0;

        video.play().catch(() => {});

    }

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("animePlayerModal"));

    modal.show();

    setTimeout(() => {

        if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

    }, 100);

    // 清空彈幕覆蓋層（無預設彈幕）

    clearInterval(danmakuInterval);

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) overlay.innerHTML = "";

};

// 動態渲染分P選集按鈕

function renderKazumiEpisodes(bvid, episodes) {

    const container = document.querySelector(".episode-list-container");

    if (!container) return;

    container.innerHTML = "";

    episodes.forEach((ep, idx) => {

        const btn = document.createElement("button");

        btn.className = `btn btn-sm ${idx === 0 ? 'btn-primary active' : 'btn-outline-secondary'} ep-btn text-truncate text-start`;

        btn.style.maxWidth = "100%";

        btn.title = ep.part;

        btn.innerHTML = `<i class="bi bi-play-fill"></i> P${ep.page}: ${escapeHtml(ep.part)}`;

        btn.onclick = async () => {

            document.querySelectorAll(".ep-btn").forEach(b => {

                b.classList.remove("btn-primary", "active");

                b.classList.add("btn-outline-secondary");

            });

            btn.classList.remove("btn-outline-secondary");

            btn.classList.add("btn-primary", "active");

            

            showToast(`正在切換至 P${ep.page}「${ep.part}」...`, "bi-play-circle text-info");

            const baseTitle = window.currentKazumiAnimeTitle || 'Bilibili 影片';

            const epTitle = `P${ep.page}: ${ep.part}`;

            const tEl = document.getElementById('animePlayerTitle');

            if (tEl) tEl.textContent = `${baseTitle} - ${epTitle}`;

            if (typeof window.saveWatchHistory === 'function') {

                window.saveWatchHistory(baseTitle, kazumiState.cover || '', epTitle, `https://www.bilibili.com/video/${bvid}?p=${ep.page}`, 0, 0, 'bilibili');

            }

            // 優先請求原生 MP4 直連串流，支援原生播放器控制

            try {

                const streamRes = await fetch(`/api/kazumi/bilibili-playurl?bvid=${bvid}&cid=${ep.cid || 0}`);

                const streamData = await streamRes.json();

                if (streamData.success && streamData.isDirectStream && streamData.streamUrl) {

                    const video = document.getElementById("kazumiVideoPlayer");

                    const iframe = document.getElementById("kazumiIframePlayer");

                    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

                    if (iframeWrapper) iframeWrapper.style.display = "none";

                    if (iframe) { iframe.src = ""; iframe.style.display = "none"; }

                    if (video) {

                        video.style.display = "block";

                        video.controls = false;

                        video.removeAttribute("controls");

                        video.src = streamData.streamUrl;

                        video.currentTime = 0;

                        video.play().catch(() => {});

                    }

                    showToast(`Kazumi: 已切換至 P${ep.page} 原生高畫質串流！`, "bi-play-circle-fill text-success");

                    createBulletDanmaku(`--- 切換至 P${ep.page}「${ep.part}」 ---`, "#f59e0b");

                    if (ep.cid) startDanmakuStream(ep.part, ep.cid);

                    return;

                }

            } catch (e) {}

            // 降級回退至官方內嵌播放器

            const iframe = document.getElementById("kazumiIframePlayer");

            const iframeWrapper = document.getElementById("kazumiIframeWrapper");

            const video = document.getElementById("kazumiVideoPlayer");

            if (video) { video.pause(); video.style.display = "none"; }

            if (iframeWrapper) {

                iframeWrapper.style.display = "block";

                iframeWrapper.classList.add("is-bilibili");

            }

            if (iframe) {

                iframe.style.display = "block";

                iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=${ep.page}&high_quality=1&as_wide=1&danmaku=0`;

            }

            showToast(`Kazumi: 已切換至 P${ep.page}「${ep.part}」！`, "bi-play-circle-fill text-danger");

            createBulletDanmaku(`--- 切換至 P${ep.page}「${ep.part}」 ---`, "#f59e0b");

            if (ep.cid) {

                startDanmakuStream(ep.part, ep.cid);

            }

        };

        container.appendChild(btn);

    });

}

window.closeAnimePlayer = function() {

    try {

        if (typeof window.saveCurrentAnimeProgressNow === 'function') {

            window.saveCurrentAnimeProgressNow();

        }

    } catch (e) {}

    if (fsHideTimer) {

        clearTimeout(fsHideTimer);

        fsHideTimer = null;

    }

    const cont = document.getElementById("kazumiScreenContainer");

    if (cont) {

        cont.classList.remove("fs-controls-hidden", "has-blocked-fallback");

    }

    if (window.kazumiHlsInstance) {

        window.kazumiHlsInstance.destroy();

        window.kazumiHlsInstance = null;

    }

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

    const fallback = document.getElementById("kazumiBlockedFallback");

    if (fallback) fallback.style.display = "none";

    if (video) {

        video.pause();

        video.removeAttribute("src");

        video.load();

        video.controls = false;

        video.removeAttribute("controls");

    }

    if (iframeWrapper) iframeWrapper.style.display = "none";

    if (iframe) iframe.src = ""; // 停止播放

    if (typeof window.clearAllDanmakuState === 'function') {

        window.clearAllDanmakuState();

    }

};

// 防內嵌優雅降級：快速切換至其他免跳轉來源

window.quickSwitchKazumiSource = function(targetSource) {

    const title = kazumiState.title || (document.getElementById("animePlayerTitle") ? document.getElementById("animePlayerTitle").textContent.split(' - ')[0].trim() : '');

    if (!title) {

        showToast("無當前番劇片名可切換來源", "bi-exclamation-triangle text-warning");

        return;

    }

    if (targetSource === 'bilibili') {

        window.open(`https://search.bilibili.com/all?keyword=${encodeURIComponent(title)}`, '_blank');

        return;

    }

    // 關閉播放器並重新打開來源選單 (切換至 AGE動漫 等免跳轉源)

    window.closeAnimePlayer();

    const theaterModalEl = document.getElementById('animePlayerModal');

    const theaterModal = theaterModalEl ? bootstrap.Modal.getInstance(theaterModalEl) : null;

    if (theaterModal) {

        const onHidden = () => {

            theaterModalEl.removeEventListener('hidden.bs.modal', onHidden);

            openKazumiSourceModal(title, kazumiState.cover || '');

        };

        theaterModalEl.addEventListener('hidden.bs.modal', onHidden);

        theaterModal.hide();

    } else {

        openKazumiSourceModal(title, kazumiState.cover || '');

    }

};

// 關閉當前動畫，退回待命搜尋狀態 (不關閉劇院 Modal)

window.closeCurrentAnime = function() {

    resetKazumiTheater();

    if (typeof window.clearAllDanmakuState === 'function') {

        window.clearAllDanmakuState();

    }

    showToast("已關閉當前動畫，回到待命搜尋狀態", "bi-stop-circle text-danger");

};

window.switchEpisode = function(epNum, btn) {

    document.querySelectorAll(".ep-btn").forEach(b => {

        b.classList.remove("btn-primary", "active");

        b.classList.add("btn-outline-secondary");

    });

    btn.classList.remove("btn-outline-secondary");

    btn.classList.add("btn-primary", "active");

    const video = document.getElementById("kazumiVideoPlayer");

    video.currentTime = 0;

    video.play().catch(() => {});

    showToast(`Kazumi: 已切換至 第 ${String(epNum).padStart(2, '0')} 話，串流載入中...`, "bi-play-circle-fill text-danger");

};

// ==========================================

// Kazumi 彈幕引擎與設置核心 (外觀/播放/時間軸嚴格對齊)

// ==========================================

const DANMAKU_SETTINGS_KEY = "kazumi_danmaku_settings";

let danmakuConfig = {

    sourcePreference: "bilibili", // "bilibili" (免金鑰官方直連) 或 "dandanplay" (需金鑰全網聚合)

    fontSize: 24,           // 14 ~ 38 px

    opacity: 100,           // 20 ~ 100 %

    displayArea: 100,       // 25, 50, 75, 100 %

    lineHeight: 1.6,        // 1.0 ~ 2.4

    duration: 8,            // 4 ~ 15 秒

    syncSpeed: true,        // 跟隨影片倍速

    timeOffset: 0.0,        // 彈幕時間校準 (-10.0 ~ +10.0s)

    blockWords: "",         // 屏蔽關鍵字 (逗號分隔)

    scrollDanmaku: true,

    topDanmaku: true,

    bottomDanmaku: true

};

function loadDanmakuSettings() {

    try {

        const saved = localStorage.getItem(DANMAKU_SETTINGS_KEY);

        if (saved) {

            danmakuConfig = Object.assign(danmakuConfig, JSON.parse(saved));

        }

    } catch (e) {}

}

function saveDanmakuSettings() {

    try {

        localStorage.setItem(DANMAKU_SETTINGS_KEY, JSON.stringify(danmakuConfig));

    } catch (e) {}

    applyDanmakuConfigToCSS();

}

function applyDanmakuConfigToCSS() {

    const overlay = document.getElementById("danmakuOverlay");

    if (!overlay) return;

    overlay.style.setProperty("--danmaku-font-size", `${danmakuConfig.fontSize}px`);

    overlay.style.setProperty("--danmaku-opacity", `${danmakuConfig.opacity / 100}`);

    overlay.style.setProperty("--danmaku-line-height", `${danmakuConfig.lineHeight}`);

    // 計算速度 (若開啟跟隨倍速，依據 video.playbackRate 計算飛行時間)

    const video = document.getElementById("kazumiVideoPlayer");

    const rate = (video && danmakuConfig.syncSpeed && video.playbackRate > 0) ? video.playbackRate : 1.0;

    const effectiveDuration = (danmakuConfig.duration / rate).toFixed(2);

    overlay.style.setProperty("--danmaku-duration", `${effectiveDuration}s`);

}

// 清除螢幕上現存的所有彈幕

function clearDanmakuScreen() {

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) overlay.innerHTML = "";

}

// 徹底清空所有彈幕狀態（佇列、畫面、側邊欄列表、徽章、時間軸計時器）

window.clearAllDanmakuState = function() {

    if (danmakuInterval) {

        clearInterval(danmakuInterval);

        danmakuInterval = null;

    }

    clearDanmakuScreen();

    currentDanmakuQueue = [];

    window.currentDanmakuList = [];

    window.currentPlayingAnime = null;

    virtualDanmakuTime = 0;

    lastSyncVideoTime = 0;

    isDanmakuPaused = true;

    // 清空側邊欄彈幕清單與計數徽章

    const container = document.getElementById("danmakuListItemsContainer");

    if (container) {

        container.innerHTML = `

            <div class="text-center py-5 text-white-50 small">

                <i class="bi bi-chat-dots fs-3 d-block mb-2 text-warning opacity-75"></i>

                <div>動漫劇院待命中，未載入彈幕</div>

            </div>

        `;

    }

    const badge = document.getElementById("dmkSidebarCountBadge");

    if (badge) badge.textContent = "0";

    const totalBadge = document.getElementById("dmkListTotalBadge");

    if (totalBadge) totalBadge.textContent = "0 則";

    const srcLabel = document.getElementById("dmkCurrentSourceLabel");

    if (srcLabel) srcLabel.textContent = "來源：待命中";

    // 重設時間軸顯示

    updateDanmakuTimeDisplay(0, 1440);

    updatePlayPauseButtonUI(true);

    // 切回選集列表分頁

    if (typeof window.switchTheaterSidebarTab === 'function') {

        window.switchTheaterSidebarTab('episodes');

    }

};

// 彈幕發送與飄字動畫 (支援顯示區域與屏蔽詞過濾)

function createBulletDanmaku(text, color = "#ffffff", mode = 1) {

    if (!danmakuEnabled || !text) return;

    // 關鍵字過濾

    if (danmakuConfig.blockWords) {

        const blocked = danmakuConfig.blockWords.split(/[,，\s]+/).filter(Boolean);

        if (blocked.some(word => text.includes(word))) return;

    }

    // 彈幕類型過濾 (mode: 1 滾動, 4 底部, 5 頂部)

    if (mode === 1 && !danmakuConfig.scrollDanmaku) return;

    if (mode === 5 && !danmakuConfig.topDanmaku) return;

    if (mode === 4 && !danmakuConfig.bottomDanmaku) return;

    const overlay = document.getElementById("danmakuOverlay");

    if (!overlay) return;

    const bullet = document.createElement("div");

    bullet.className = "danmaku-bullet";

    bullet.textContent = text;

    bullet.style.color = color;

    // 依據「顯示區域」限制垂直分佈

    const maxArea = Math.min(Math.max(danmakuConfig.displayArea, 20), 100) / 100;

    const topPct = (Math.random() * (maxArea * 0.75) + 0.05) * 100;

    bullet.style.top = topPct.toFixed(1) + "%";

    if (mode === 5) {

        bullet.classList.add("danmaku-top");

        bullet.style.top = "8%";

    } else if (mode === 4) {

        bullet.classList.add("danmaku-bottom");

        bullet.style.top = "85%";

    }

    overlay.appendChild(bullet);

    // 當 CSS 動畫自然播放結束後安全移除 DOM 節點 (暫停凍結時不會觸發 animationend，避免暫停時文字提早消失)

    bullet.addEventListener("animationend", () => bullet.remove(), { once: true });

    // 保險 Fallback：若瀏覽器未觸發事件，在超長時限後清理

    const maxFallbackMs = (danmakuConfig.duration + 15) * 1000;

    setTimeout(() => {

        if (bullet.parentNode) bullet.remove();

    }, maxFallbackMs);

}

let currentDanmakuQueue = [];

let lastSyncVideoTime = 0;

let virtualDanmakuTime = 0;

let isDanmakuPaused = false;

// 串接 Kazumi 後端彈幕流 (支援 彈彈play 全網聚合與 B站官方即時彈幕)

async function startDanmakuStream(animeTitle, cid = null, episodeNo = 1) {

    if (danmakuInterval) {

        clearInterval(danmakuInterval);

        danmakuInterval = null;

    }

    clearDanmakuScreen();

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) {

        overlay.style.display = danmakuEnabled ? "block" : "none";

        overlay.classList.remove("danmaku-paused");

    }

    applyDanmakuConfigToCSS();

    window.currentPlayingAnime = { title: animeTitle, cid: cid, ep: episodeNo };

    const appId = localStorage.getItem("dandanplay_app_id") || "";

    const appSecret = localStorage.getItem("dandanplay_app_secret") || "";

    if (!animeTitle && !cid) return;

    let danmakuQueue = [];

    try {

        let queryParams = [];

        const sourcePref = danmakuConfig.sourcePreference || localStorage.getItem('danmaku_source_preference') || 'bilibili';

        queryParams.push(`source=${encodeURIComponent(sourcePref)}`);

        if (animeTitle) queryParams.push(`anime=${encodeURIComponent(animeTitle)}&ep=${episodeNo}`);

        if (cid) queryParams.push(`cid=${cid}`);

        if (appId && appSecret) queryParams.push(`appId=${encodeURIComponent(appId)}&appSecret=${encodeURIComponent(appSecret)}`);

        const res = await fetch(`/api/kazumi/danmaku?${queryParams.join('&')}`);

        if (res.ok) {

            const data = await res.json();

            if (data.success && Array.isArray(data.danmaku) && data.danmaku.length > 0) {

                danmakuQueue = data.danmaku;

                if (data.source === 'dandanplay') {

                    showToast(`已載入彈彈play全網聚合彈幕 (${data.count} 則)`, "bi-chat-dots-fill text-warning");

                } else if (data.source === 'bilibili_live') {

                    showToast(`已載入 Bilibili 官方即時彈幕 (${data.count} 則)`, "bi-play-btn-fill text-info");

                }

            }

        }

    } catch (e) {

        console.warn('Real danmaku fetch error:', e);

    }

    if (danmakuQueue.length === 0) {

        currentDanmakuQueue = [];

        renderDanmakuList([]);

        return;

    }

    // 嚴格依照時間 (秒) 升冪排序，並初始化發送狀態

    danmakuQueue.sort((a, b) => (parseFloat(a.time) || 0) - (parseFloat(b.time) || 0));

    danmakuQueue.forEach(item => {

        item._fired = false;

        item.numericTime = parseFloat(item.time) || 0;

    });

    currentDanmakuQueue = danmakuQueue;

    window.currentDanmakuList = danmakuQueue;

    lastSyncVideoTime = 0;

    virtualDanmakuTime = 0;

    isDanmakuPaused = false;

    // 即時將載入之全量彈幕渲染至側邊欄清單與計數徽章

    renderDanmakuList(danmakuQueue);

    updateDanmakuTimeDisplay(0);

    updatePlayPauseButtonUI(false);

    startDanmakuLoop();

}

// 基於影片 currentTime 或 iframe 虛擬時間軸與時間校準 offset 嚴格對齊彈幕

function syncDanmakuWithVideoTime() {

    if (!danmakuEnabled || !currentDanmakuQueue || currentDanmakuQueue.length === 0 || isDanmakuPaused) return;

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const isVideoMode = video && video.style.display !== "none";

    const isIframeMode = iframe && iframe.style.display !== "none";

    let currentBaseTime = 0;

    if (isVideoMode) {

        if (video.paused || video.ended || video.seeking) {

            window.pauseDanmaku();

            return;

        }

        currentBaseTime = video.currentTime;

        virtualDanmakuTime = currentBaseTime;

    } else if (isIframeMode) {

        if (isDanmakuPaused) return;

        // iframe 播放模式下，使用虛擬播放時間軸推進 (每 200ms = 0.2s)

        virtualDanmakuTime += 0.2;

        currentBaseTime = virtualDanmakuTime;

    } else {

        return;

    }

    const effectiveTime = currentBaseTime + (danmakuConfig.timeOffset || 0);

    // 每秒更新一次時間軸 UI 顯示 (避免每 200ms 造成過多 DOM repaint)

    if (Math.floor(effectiveTime) !== Math.floor(lastSyncVideoTime)) {

        updateDanmakuTimeDisplay(effectiveTime);

    }

    // 找出落在 [effectiveTime - 1.2, effectiveTime + 0.3] 之間且尚未發送的彈幕

    for (let i = 0; i < currentDanmakuQueue.length; i++) {

        const item = currentDanmakuQueue[i];

        if (item.numericTime > effectiveTime + 0.3) break; // 已排序，後續必定超過

        if (!item._fired && item.numericTime >= effectiveTime - 1.5) {

            createBulletDanmaku(item.content, item.color || "#ffffff", item.mode || 1);

            item._fired = true;

        }

    }

    lastSyncVideoTime = effectiveTime;

}

function startDanmakuLoop() {

    if (danmakuInterval) clearInterval(danmakuInterval);

    if (!currentDanmakuQueue || currentDanmakuQueue.length === 0) return;

    // 確保彈幕圖層為可見

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) overlay.style.display = "block";

    // 每 200ms 高頻精準對齊時間軸

    danmakuInterval = setInterval(syncDanmakuWithVideoTime, 200);

}

// 廣播跨域與通用播放器指令給 iframe 內嵌播放器 (相容 Bilibili, YouTube Iframe API, DPlayer, ArtPlayer 等)

function sendIframePlaybackCommand(cmd, time = 0) {

    const iframe = document.getElementById("kazumiIframePlayer");

    if (!iframe || !iframe.contentWindow) return;

    const targetSec = Math.max(0, Math.floor(time));

    try {

        // 0. Tampermonkey Bridge 專屬高優先度直達控制

        iframe.contentWindow.postMessage({

            target: 'kazumi_iframe_video',

            action: cmd,

            time: targetSec

        }, '*');

        if (cmd === 'pause') {

            // YouTube

            iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');

            // DPlayer / ArtPlayer / Bilibili / HTML5 PostMessage

            iframe.contentWindow.postMessage({ type: 'pause' }, '*');

            iframe.contentWindow.postMessage({ event: 'pause' }, '*');

            iframe.contentWindow.postMessage({ action: 'pause' }, '*');

        } else if (cmd === 'play') {

            // YouTube

            iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');

            iframe.contentWindow.postMessage({ type: 'play' }, '*');

            iframe.contentWindow.postMessage({ event: 'play' }, '*');

            iframe.contentWindow.postMessage({ action: 'play' }, '*');

        } else if (cmd === 'seek') {

            // YouTube

            iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [targetSec, true] }), '*');

            // DPlayer / ArtPlayer / Bilibili

            iframe.contentWindow.postMessage({ type: 'seek', time: targetSec }, '*');

            iframe.contentWindow.postMessage({ type: 'setCurrentTime', value: targetSec }, '*');

            iframe.contentWindow.postMessage({ action: 'seek', time: targetSec }, '*');

        }

    } catch (e) {}

}

// 核心主控播放與暫停協調器：徹底實現「按下暫停/空白鍵時，影片與彈幕 100% 同時凍結/恢復」

window.toggleMasterPlayPause = function() {

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const isVideoMode = video && video.style.display !== "none";

    const isIframeMode = iframe && iframe.style.display !== "none";

    if (isVideoMode) {

        if (video.paused) {

            video.play().catch(() => {});

        } else {

            video.pause();

        }

    } else if (isIframeMode) {

        if (isDanmakuPaused) {

            window.resumeDanmaku();

            sendIframePlaybackCommand('play');

            showToast("▶️ 已繼續播放影片與彈幕", "bi-play-fill text-success");

        } else {

            window.pauseDanmaku();

            sendIframePlaybackCommand('pause');

            showToast("⏸️ 已暫停影片與凍結彈幕", "bi-pause-fill text-warning");

        }

    } else {

        if (isDanmakuPaused) {

            window.resumeDanmaku();

        } else {

            window.pauseDanmaku();

        }

    }

};

window.toggleDanmakuPlayPause = window.toggleMasterPlayPause;

// 影片暫停時立即凍結動畫與停止發射 (徹底解決影片暫停彈幕仍一直播出的問題)

window.pauseDanmaku = function() {

    isDanmakuPaused = true;

    if (danmakuInterval) {

        clearInterval(danmakuInterval);

        danmakuInterval = null;

    }

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) {

        overlay.classList.add("danmaku-paused");

        // 強制將畫面上所有正在飛行的彈幕 animationPlayState 設為 paused

        const bullets = overlay.querySelectorAll(".danmaku-bullet");

        bullets.forEach(b => {

            b.style.animationPlayState = "paused";

        });

    }

    updatePlayPauseButtonUI(true);

};

// 影片播放時立即解凍並恢復時間軸同步

window.resumeDanmaku = function() {

    isDanmakuPaused = false;

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) {

        overlay.classList.remove("danmaku-paused");

        const bullets = overlay.querySelectorAll(".danmaku-bullet");

        bullets.forEach(b => {

            b.style.animationPlayState = "running";

        });

    }

    applyDanmakuConfigToCSS();

    updatePlayPauseButtonUI(false);

    if (danmakuEnabled && currentDanmakuQueue && currentDanmakuQueue.length > 0) {

        startDanmakuLoop();

    }

};

function updatePlayPauseButtonUI(paused) {

    const btn = document.getElementById("danmakuPlayPauseBtn");

    const btnText = document.getElementById("danmakuPlayPauseBtnText");

    const miniIcon = document.getElementById("danmakuMiniPlayPauseIcon");

    const mainIcon = btn ? btn.querySelector("i") : null;

    if (paused) {

        if (btn) {

            btn.className = "btn btn-sm btn-warning text-dark fw-bold rounded-pill px-2";

            btn.title = "繼續彈幕飄動 (快捷鍵: 空白鍵 Space)";

        }

        if (mainIcon) mainIcon.className = "bi bi-play-fill";

        if (btnText) btnText.textContent = "繼續";

        if (miniIcon) miniIcon.className = "bi bi-play-fill";

    } else {

        if (btn) {

            btn.className = "btn btn-sm btn-outline-warning rounded-pill px-2";

            btn.title = "暫停彈幕飄動 (快捷鍵: 空白鍵 Space)";

        }

        if (mainIcon) mainIcon.className = "bi bi-pause-fill";

        if (btnText) btnText.textContent = "暫停";

        if (miniIcon) miniIcon.className = "bi bi-pause-fill";

    }

}

// 計算目前彈幕佇列的最大時間（影片總長度估計，預設至少 24 分鐘 = 1440 秒）

function getDanmakuMaxDuration() {

    let maxSec = 1440;

    if (currentDanmakuQueue && currentDanmakuQueue.length > 0) {

        const lastItem = currentDanmakuQueue[currentDanmakuQueue.length - 1];

        if (lastItem && lastItem.numericTime > 60) {

            maxSec = Math.max(maxSec, Math.ceil(lastItem.numericTime + 60));

        }

    }

    const video = document.getElementById("kazumiVideoPlayer");

    if (video && video.duration && !isNaN(video.duration) && video.duration > 0) {

        maxSec = Math.ceil(video.duration);

    }

    return maxSec;

}

function formatDanmakuMinSec(totalSeconds) {

    const s = Math.max(0, Math.floor(totalSeconds));

    const m = Math.floor(s / 60);

    const remS = s % 60;

    return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;

}

function updateDanmakuTimeDisplay(currentSec, totalSec = null) {

    const maxSec = totalSec || getDanmakuMaxDuration();

    const cur = Math.max(0, Math.min(currentSec, maxSec));

    const timeDisplay = document.getElementById("theaterDanmakuTimeDisplay");

    if (timeDisplay) {

        timeDisplay.textContent = `${formatDanmakuMinSec(cur)} / ${formatDanmakuMinSec(maxSec)}`;

    }

    const slider = document.getElementById("danmakuTimelineSlider");

    if (slider) {

        slider.max = maxSec;

        slider.value = Math.floor(cur);

    }

}

// 核心跳轉協調器：徹底實現跳轉時間點「影片（HTML5 / iframe）與彈幕 100% 同步」

window.seekMasterTimeline = function(targetSec) {

    const sec = Math.max(0, parseFloat(targetSec) || 0);

    clearDanmakuScreen();

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const isVideoMode = video && video.style.display !== "none";

    const isIframeMode = iframe && iframe.style.display !== "none";

    virtualDanmakuTime = sec;

    lastSyncVideoTime = sec;

    if (isVideoMode) {

        try { video.currentTime = sec; } catch (e) {}

    } else if (isIframeMode) {

        sendIframePlaybackCommand('seek', sec);

    }

    if (currentDanmakuQueue && currentDanmakuQueue.length > 0) {

        currentDanmakuQueue.forEach(item => {

            // 跳轉時間點之前的彈幕標記為已發(_fired = true)，該時間點之後的彈幕標記為未發(_fired = false)

            item._fired = (item.numericTime < sec);

        });

    }

    updateDanmakuTimeDisplay(sec);

};

window.seekDanmaku = function(targetSec = null) {

    if (targetSec !== null && !isNaN(targetSec)) {

        window.seekMasterTimeline(targetSec);

    } else {

        const video = document.getElementById("kazumiVideoPlayer");

        const isVideoMode = video && video.style.display !== "none";

        const cur = isVideoMode ? (video.currentTime || 0) : virtualDanmakuTime;

        window.seekMasterTimeline(cur);

    }

};

// 點擊側邊欄彈幕時間戳記直接跳轉 (影片與彈幕同步)

window.jumpToDanmakuTime = function(sec) {

    window.seekMasterTimeline(sec);

    if (isDanmakuPaused) {

        window.toggleMasterPlayPause();

    }

    showToast(`⏱️ 影片與彈幕已跳轉至 ${formatDanmakuMinSec(sec)}！`, "bi-clock-history text-info");

};

// 點擊百分比快捷按鈕跳轉 (0%, 25%, 50%, 75%) (影片與彈幕同步)

window.jumpToDanmakuPercent = function(pct) {

    const maxSec = getDanmakuMaxDuration();

    const target = (maxSec * pct) / 100;

    window.seekMasterTimeline(target);

    if (isDanmakuPaused) {

        window.toggleMasterPlayPause();

    }

    showToast(`🚀 影片與彈幕已跳轉至 ${pct}% (${formatDanmakuMinSec(target)})`, "bi-fast-forward-fill text-warning");

};

// 相對快進/快退秒數 (+10s, -10s) (影片與彈幕同步)

window.jumpDanmakuRelative = function(deltaSec) {

    const target = Math.max(0, virtualDanmakuTime + deltaSec);

    window.seekMasterTimeline(target);

    showToast(`⏱️ 影片與彈幕 ${deltaSec > 0 ? '+' : ''}${deltaSec}s (${formatDanmakuMinSec(target)})`, "bi-arrow-left-right text-info");

};

// 滑桿拖動時即時反饋

window.onDanmakuTimelineSliderInput = function(val) {

    const sec = parseFloat(val) || 0;

    const timeDisplay = document.getElementById("theaterDanmakuTimeDisplay");

    if (timeDisplay) {

        timeDisplay.textContent = `${formatDanmakuMinSec(sec)} / ${formatDanmakuMinSec(getDanmakuMaxDuration())}`;

    }

};

// 滑桿放開時正式跳轉同步 (影片與彈幕同步)

window.onDanmakuTimelineSliderChange = function(val) {

    const sec = parseFloat(val) || 0;

    window.seekMasterTimeline(sec);

    if (isDanmakuPaused) {

        window.toggleMasterPlayPause();

    }

    showToast(`⏱️ 影片與彈幕已對齊至 ${formatDanmakuMinSec(sec)}`, "bi-sliders text-success");

};

// ==========================================

// Kazumi 動漫劇院純淨化：音量控制系統 (按鈕、拉桿、滾輪、鍵盤方向鍵 ↑↓、M 鍵靜音)

// ==========================================

let kazumiCurrentVolume = parseInt(localStorage.getItem('kazumi_theater_volume') || '100', 10);

if (isNaN(kazumiCurrentVolume) || kazumiCurrentVolume < 0) kazumiCurrentVolume = 100;

if (kazumiCurrentVolume > 100) kazumiCurrentVolume = 100;

let kazumiIsMuted = localStorage.getItem('kazumi_theater_muted') === 'true';

let kazumiVolumeHudTimer = null;

// 廣播音量給 iframe (相容 YouTube Iframe API, Bilibili, DPlayer, ArtPlayer, Tampermonkey Bridge)

function sendIframeVolumeCommand(vol, isMuted) {

    const iframe = document.getElementById("kazumiIframePlayer");

    if (!iframe || !iframe.contentWindow) return;

    const effectiveVol = isMuted ? 0 : Math.max(0, Math.min(100, vol));

    try {

        // Tampermonkey Bridge

        iframe.contentWindow.postMessage({

            target: 'kazumi_iframe_video',

            action: 'volume',

            volume: effectiveVol / 100,

            muted: isMuted

        }, '*');

        // YouTube Iframe API

        iframe.contentWindow.postMessage(JSON.stringify({

            event: 'command',

            func: isMuted ? 'mute' : 'unMute',

            args: ''

        }), '*');

        iframe.contentWindow.postMessage(JSON.stringify({

            event: 'command',

            func: 'setVolume',

            args: [effectiveVol]

        }), '*');

        // Bilibili / DPlayer / ArtPlayer / xgplayer / HTML5

        const ratio = effectiveVol / 100;

        iframe.contentWindow.postMessage({ type: 'volume', volume: ratio }, '*');

        iframe.contentWindow.postMessage({ type: 'setVolume', value: ratio }, '*');

        iframe.contentWindow.postMessage({ action: 'volume', data: ratio }, '*');

        iframe.contentWindow.postMessage({ type: 'artplayer:volume', data: ratio }, '*');

        iframe.contentWindow.postMessage({ type: 'dplayer', action: 'volume', volume: ratio }, '*');

        iframe.contentWindow.postMessage({ from: 'kazumi_theater', type: 'volume', value: ratio }, '*');

    } catch (e) {}

}

window.showKazumiVolumeHud = function(vol, isMuted) {

    const hud = document.getElementById("kazumiVolumeHud");

    const icon = document.getElementById("volumeHudIcon");

    const text = document.getElementById("volumeHudText");

    if (!hud) return;

    const effectiveVol = isMuted ? 0 : vol;

    if (text) text.textContent = isMuted ? "靜音" : `${effectiveVol}%`;

    if (icon) {

        if (isMuted || effectiveVol === 0) {

            icon.className = "bi bi-volume-mute-fill text-danger";

        } else if (effectiveVol <= 50) {

            icon.className = "bi bi-volume-down-fill text-warning";

        } else {

            icon.className = "bi bi-volume-up-fill text-success";

        }

    }

    hud.classList.remove("d-none");

    hud.classList.add("d-flex");

    if (kazumiVolumeHudTimer) clearTimeout(kazumiVolumeHudTimer);

    kazumiVolumeHudTimer = setTimeout(() => {

        hud.classList.add("d-none");

        hud.classList.remove("d-flex");

    }, 1200);

};

window.applyKazumiVolume = function(showHud = false) {

    const video = document.getElementById("kazumiVideoPlayer");

    const slider = document.getElementById("danmakuVolumeSlider");

    const label = document.getElementById("danmakuVolumeLabel");

    const icon = document.getElementById("danmakuVolumeIcon");

    const effectiveVol = kazumiIsMuted ? 0 : kazumiCurrentVolume;

    // 1. 套用至 HTML5 video

    if (video) {

        video.volume = Math.max(0, Math.min(1, kazumiCurrentVolume / 100));

        video.muted = kazumiIsMuted;

        video.controls = false;

        video.removeAttribute("controls");

    }

    // 2. 廣播給 iframe

    sendIframeVolumeCommand(kazumiCurrentVolume, kazumiIsMuted);

    // 3. 更新 UI 元件狀態

    if (slider) slider.value = effectiveVol;

    if (label) label.textContent = `${effectiveVol}%`;

    if (icon) {

        if (kazumiIsMuted || effectiveVol === 0) {

            icon.className = "bi bi-volume-mute-fill text-danger";

        } else if (effectiveVol <= 50) {

            icon.className = "bi bi-volume-down-fill text-warning";

        } else {

            icon.className = "bi bi-volume-up-fill";

        }

    }

    // 4. 持久化至 localStorage

    localStorage.setItem('kazumi_theater_volume', kazumiCurrentVolume);

    localStorage.setItem('kazumi_theater_muted', kazumiIsMuted ? 'true' : 'false');

    if (showHud) {

        window.showKazumiVolumeHud(kazumiCurrentVolume, kazumiIsMuted);

    }

};

window.toggleKazumiVolumeMute = function() {

    kazumiIsMuted = !kazumiIsMuted;

    window.applyKazumiVolume(true);

};

window.onKazumiVolumeInput = function(val) {

    const v = parseInt(val, 10);

    if (!isNaN(v)) {

        kazumiCurrentVolume = Math.max(0, Math.min(100, v));

        if (kazumiIsMuted && kazumiCurrentVolume > 0) {

            kazumiIsMuted = false;

        }

        window.applyKazumiVolume(true);

    }

};

window.onKazumiVolumeChange = function(val) {

    window.onKazumiVolumeInput(val);

};

window.adjustKazumiVolume = function(delta) {

    if (kazumiIsMuted) kazumiIsMuted = false;

    kazumiCurrentVolume = Math.max(0, Math.min(100, kazumiCurrentVolume + delta));

    window.applyKazumiVolume(true);

};

// ==========================================

// 彈幕列表側邊欄功能 (右側完全不遮擋左側畫面，即時瀏覽與搜尋)

// ==========================================

window.switchTheaterSidebarTab = function(tabName) {

    const tabEp = document.getElementById("tabBtnEpisodes");

    const tabDm = document.getElementById("tabBtnDanmaku");

    const panelEp = document.getElementById("kazumiEpisodesPanel");

    const panelDm = document.getElementById("kazumiDanmakuPanel");

    if (tabName === 'danmaku') {

        if (tabDm) {

            tabDm.className = "btn btn-sm btn-primary rounded-pill fw-bold text-white theater-sidebar-tab active";

        }

        if (tabEp) {

            tabEp.className = "btn btn-sm btn-outline-light border-0 rounded-pill fw-semibold text-white theater-sidebar-tab";

        }

        if (panelEp) panelEp.classList.add("d-none");

        if (panelDm) {

            panelDm.classList.remove("d-none");

            panelDm.classList.add("d-flex");

        }

        renderDanmakuList(currentDanmakuQueue || []);

        const input = document.getElementById("dmkSidebarSearchInput");

        if (input) input.focus();

    } else {

        if (tabEp) {

            tabEp.className = "btn btn-sm btn-primary rounded-pill fw-bold text-white theater-sidebar-tab active";

        }

        if (tabDm) {

            tabDm.className = "btn btn-sm btn-outline-light border-0 rounded-pill fw-semibold text-white theater-sidebar-tab";

        }

        if (panelDm) {

            panelDm.classList.remove("d-flex");

            panelDm.classList.add("d-none");

        }

        if (panelEp) panelEp.classList.remove("d-none");

    }

};

window.openDanmakuListModal = function() {

    window.switchTheaterSidebarTab('danmaku');

};

function formatDanmakuSeconds(sec) {

    const s = Math.max(0, Math.floor(sec || 0));

    const m = Math.floor(s / 60);

    const rem = s % 60;

    return `${m.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;

}

window.filterDanmakuList = function(keyword) {

    const kw = (keyword || '').trim().toLowerCase();

    if (!currentDanmakuQueue || currentDanmakuQueue.length === 0) {

        renderDanmakuList([]);

        return;

    }

    if (!kw) {

        renderDanmakuList(currentDanmakuQueue);

        return;

    }

    const filtered = currentDanmakuQueue.filter(item => (item.content || '').toLowerCase().includes(kw));

    renderDanmakuList(filtered, kw);

};

function renderDanmakuList(list, keyword = '') {

    const container = document.getElementById("danmakuListItemsContainer");

    const countBadge = document.getElementById("dmkListTotalBadge");

    const sidebarBadge = document.getElementById("dmkSidebarCountBadge");

    const sourceLabel = document.getElementById("dmkCurrentSourceLabel");

    if (!container) return;

    const countStr = `${list ? list.length : 0} 則`;

    if (countBadge) countBadge.textContent = countStr;

    if (sidebarBadge) sidebarBadge.textContent = `${list ? list.length : 0}`;

    const pref = danmakuConfig.sourcePreference || localStorage.getItem('danmaku_source_preference') || 'bilibili';

    if (sourceLabel) {

        sourceLabel.textContent = pref === 'dandanplay' ? '來源：彈彈play 全網聚合' : '來源：Bilibili 官方即時';

    }

    if (!list || list.length === 0) {

        container.innerHTML = `

            <div class="text-center py-5 text-white-50 small">

                <i class="bi bi-chat-dots fs-3 d-block mb-2 text-warning opacity-75"></i>

                <div>${keyword ? '未找到符合關鍵字的彈幕' : '當前集數尚未載入彈幕或來源為空'}</div>

            </div>

        `;

        return;

    }

    container.innerHTML = list.map((item, idx) => {

        const timeStr = formatDanmakuSeconds(item.numericTime || item.time || 0);

        const color = item.color || '#ffffff';

        return `

            <div class="p-2 rounded bg-black bg-opacity-40 border border-secondary border-opacity-50 d-flex align-items-center justify-content-between gap-2 hover-bg-light transition-all">

                <div class="d-flex align-items-center gap-2 overflow-hidden flex-grow-1">

                    <span class="badge bg-dark border border-secondary text-info font-monospace flex-shrink-0" style="font-size: 0.75rem; cursor: pointer;" onclick="window.jumpToDanmakuTime(${item.numericTime || 0})" title="點擊直接將彈幕時間軸同步至此時間點">${timeStr}</span>

                    <span class="rounded-circle flex-shrink-0" style="width: 10px; height: 10px; background-color: ${color}; box-shadow: 0 0 4px ${color};"></span>

                    <span class="small text-white text-truncate" title="${escapeHtml(item.content)}">${escapeHtml(item.content)}</span>

                </div>

                <button type="button" class="btn btn-outline-success btn-xs rounded-pill flex-shrink-0 px-2" onclick="window.fireTestDanmaku('${escapeHtml(item.content)}', '${color}')" title="立即在畫面上飄送此條彈幕">

                    <i class="bi bi-play-fill"></i> 試發

                </button>

            </div>

        `;

    }).join('');

}

window.fireTestDanmaku = function(text, color) {

    createBulletDanmaku(text, color || '#ffffff');

    showToast(`🚀 已在畫面上飄送彈幕：「${text.slice(0, 15)}...」`, "bi-send-check text-success");

};

// ==========================================

// Kazumi 彈幕設置面板 UI 交互

// ==========================================

window.openDanmakuSettingsModal = function() {

    loadDanmakuSettings();

    updateDanmakuSettingsModalUI();

    const modalEl = document.getElementById("danmakuSettingsModal");

    if (modalEl) {

        const modal = new bootstrap.Modal(modalEl);

        modal.show();

    }

};

function updateDanmakuSettingsModalUI() {

    // 外觀

    const setVal = (id, val) => {

        const el = document.getElementById(id);

        if (el) el.value = val;

    };

    const setText = (id, text) => {

        const el = document.getElementById(id);

        if (el) el.textContent = text;

    };

    const setChecked = (id, bool) => {

        const el = document.getElementById(id);

        if (el) el.checked = !!bool;

    };

    setVal("dmkFontSize", danmakuConfig.fontSize);

    setText("val-dmkFontSize", danmakuConfig.fontSize);

    setVal("dmkOpacity", danmakuConfig.opacity);

    setText("val-dmkOpacity", `${danmakuConfig.opacity}%`);

    setVal("dmkDisplayArea", danmakuConfig.displayArea);

    setText("val-dmkDisplayArea", `${danmakuConfig.displayArea}%`);

    setVal("dmkLineHeight", danmakuConfig.lineHeight);

    setText("val-dmkLineHeight", danmakuConfig.lineHeight);

    setChecked("dmkTypeScroll", danmakuConfig.scrollDanmaku);

    setChecked("dmkTypeTop", danmakuConfig.topDanmaku);

    setChecked("dmkTypeBottom", danmakuConfig.bottomDanmaku);

    // 播放

    setVal("dmkDuration", danmakuConfig.duration);

    setText("val-dmkDuration", `${danmakuConfig.duration} 秒`);

    setChecked("dmkSyncSpeed", danmakuConfig.syncSpeed);

    setVal("dmkTimeOffsetRange", danmakuConfig.timeOffset);

    const offsetStr = danmakuConfig.timeOffset === 0 

        ? "0.0s (無偏移)" 

        : `${danmakuConfig.timeOffset > 0 ? '+' : ''}${danmakuConfig.timeOffset.toFixed(1)}s`;

    setText("val-dmkTimeOffset", offsetStr);

    const blockInput = document.getElementById("dmkBlockWords");

    if (blockInput) blockInput.value = danmakuConfig.blockWords || "";

    const appIdInput = document.getElementById("dmkDandanAppId");

    if (appIdInput) appIdInput.value = localStorage.getItem("dandanplay_app_id") || "";

    const appSecretInput = document.getElementById("dmkDandanAppSecret");

    if (appSecretInput) appSecretInput.value = localStorage.getItem("dandanplay_app_secret") || "";

    // 彈幕來源單選狀態同步

    const currentPref = danmakuConfig.sourcePreference || localStorage.getItem("danmaku_source_preference") || "bilibili";

    const biliRadio = document.getElementById("dmkSourceBili");

    const dandanRadio = document.getElementById("dmkSourceDandan");

    if (biliRadio && dandanRadio) {

        if (currentPref === "dandanplay") {

            dandanRadio.checked = true;

        } else {

            biliRadio.checked = true;

        }

    }

}

window.onDanmakuSourcePreferenceChanged = function(src) {

    danmakuConfig.sourcePreference = src || "bilibili";

    localStorage.setItem("danmaku_source_preference", danmakuConfig.sourcePreference);

    saveDanmakuSettings();

    const label = danmakuConfig.sourcePreference === "dandanplay" ? "彈彈play 全網聚合彈幕 (需金鑰)" : "Bilibili 官方即時彈幕 (免金鑰)";

    showToast(`📡 已切換彈幕模式：${label}`, "bi-broadcast text-success");

    // 若有當前播放中的動畫與集數，自動以新來源重新載入彈幕

    if (window.currentAnimeTitle && typeof window.initDanmakuForCurrentEpisode === "function") {

        window.initDanmakuForCurrentEpisode(window.currentAnimeTitle, window.currentEpisodeIndex || 1);

    }

};

window.onDanmakuSettingInput = function(key, val) {

    const num = parseFloat(val);

    danmakuConfig[key] = num;

    const textMap = {

        fontSize: num,

        opacity: `${num}%`,

        displayArea: `${num}%`,

        lineHeight: num,

        duration: `${num} 秒`,

        timeOffset: num === 0 ? "0.0s (無偏移)" : `${num > 0 ? '+' : ''}${num.toFixed(1)}s`

    };

    const targetValEl = document.getElementById(`val-dmk${key.charAt(0).toUpperCase() + key.slice(1)}`);

    if (targetValEl && textMap[key] !== undefined) {

        targetValEl.textContent = textMap[key];

    }

    if (key === 'timeOffset') {

        window.seekDanmaku();

    }

    saveDanmakuSettings();

};

window.onDanmakuSettingToggle = function(key, checked) {

    danmakuConfig[key] = checked;

    saveDanmakuSettings();

};

window.onDanmakuSettingBlockWords = function(val) {

    danmakuConfig.blockWords = (val || "").trim();

    saveDanmakuSettings();

    showToast("已更新彈幕屏蔽關鍵字！", "bi-shield-check text-info");

};

window.adjustDanmakuOffset = function(delta) {

    let current = parseFloat(danmakuConfig.timeOffset) || 0;

    current = Math.min(Math.max(current + delta, -10), 10);

    danmakuConfig.timeOffset = parseFloat(current.toFixed(1));

    const range = document.getElementById("dmkTimeOffsetRange");

    if (range) range.value = danmakuConfig.timeOffset;

    const offsetStr = danmakuConfig.timeOffset === 0 

        ? "0.0s (無偏移)" 

        : `${danmakuConfig.timeOffset > 0 ? '+' : ''}${danmakuConfig.timeOffset.toFixed(1)}s`;

    const label = document.getElementById("val-dmkTimeOffset");

    if (label) label.textContent = offsetStr;

    saveDanmakuSettings();

    window.seekDanmaku();

    showToast(`⏱️ 彈幕時間校準：${offsetStr}`, "bi-clock-history text-info");

};

window.resetDanmakuOffset = function() {

    danmakuConfig.timeOffset = 0;

    const range = document.getElementById("dmkTimeOffsetRange");

    if (range) range.value = 0;

    const label = document.getElementById("val-dmkTimeOffset");

    if (label) label.textContent = "0.0s (無偏移)";

    saveDanmakuSettings();

    window.seekDanmaku();

    showToast("⏱️ 已重置彈幕時間偏移！", "bi-check-circle text-success");

};

window.resetDanmakuSettingsDefault = function() {

    danmakuConfig = {

        fontSize: 24,

        opacity: 100,

        displayArea: 100,

        lineHeight: 1.6,

        duration: 8,

        syncSpeed: true,

        timeOffset: 0.0,

        blockWords: "",

        scrollDanmaku: true,

        topDanmaku: true,

        bottomDanmaku: true

    };

    saveDanmakuSettings();

    updateDanmakuSettingsModalUI();

    window.seekDanmaku();

    showToast("已恢復 Kazumi 預設彈幕設置！", "bi-arrow-counterclockwise text-success");

};

window.saveDandanplayFromModal = function() {

    const appIdInput = document.getElementById("dmkDandanAppId");

    const appSecretInput = document.getElementById("dmkDandanAppSecret");

    if (appIdInput && appSecretInput) {

        localStorage.setItem("dandanplay_app_id", appIdInput.value.trim());

        localStorage.setItem("dandanplay_app_secret", appSecretInput.value.trim());

        showToast("🎉 彈彈play 官方 API 金鑰已成功儲存！", "bi-key-fill text-success");

    }

};

window.promptDandanplayConfig = function() {

    window.openDanmakuSettingsModal();

};

// 彈幕按鈕事件綁定

document.addEventListener("DOMContentLoaded", () => {

    const danmakuBtn = document.getElementById("sendDanmakuBtn");

    const danmakuInput = document.getElementById("danmakuInput");

    const toggleBtn = document.getElementById("danmakuToggleBtn");

    if (danmakuBtn && danmakuInput) {

        danmakuBtn.addEventListener("click", () => {

            const val = danmakuInput.value.trim();

            if (val) {

                createBulletDanmaku(val, "#22c55e");

                danmakuInput.value = "";

                showToast("彈幕發送成功！", "bi-chat-dots-fill text-success");

            }

        });

        danmakuInput.addEventListener("keydown", (e) => {

            if (e.key === "Enter") danmakuBtn.click();

        });

    }

    if (toggleBtn) {

        toggleBtn.addEventListener("click", () => {

            window.toggleDanmaku();

        });

    }

    // 全螢幕狀態變化監聽

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    document.addEventListener("mozfullscreenchange", handleFullscreenChange);

    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    const animeModalEl = document.getElementById("animePlayerModal");

    if (animeModalEl) {

        animeModalEl.addEventListener("hidden.bs.modal", () => {

            closeAnimePlayer();

        });

    }

    // 監聽播放器播放/暫停/跳轉事件，實現彈幕與畫面嚴格同步

    const kazumiVideo = document.getElementById("kazumiVideoPlayer");

    if (kazumiVideo) {

        kazumiVideo.addEventListener("click", (e) => {

            e.preventDefault();

            window.toggleDanmakuPlayPause();

        });

        kazumiVideo.addEventListener("dblclick", (e) => {

            e.preventDefault();

            window.toggleKazumiFullscreen();

        });

        kazumiVideo.addEventListener("pause", () => {

            window.pauseDanmaku();

            window.saveCurrentAnimeProgressNow();

        });

        const syncKazumiVideoVolume = () => {

            if (typeof window.applyKazumiVolume === 'function') {

                window.applyKazumiVolume(false);

            }

        };

        kazumiVideo.addEventListener("loadedmetadata", syncKazumiVideoVolume);

        kazumiVideo.addEventListener("canplay", syncKazumiVideoVolume);

        kazumiVideo.addEventListener("play", () => {

            window.resumeDanmaku();

            syncKazumiVideoVolume();

        });

        kazumiVideo.addEventListener("playing", syncKazumiVideoVolume);

        kazumiVideo.addEventListener("timeupdate", () => {

            if (!kazumiVideo.paused && !kazumiVideo.seeking) {

                updateDanmakuTimeDisplay(kazumiVideo.currentTime, kazumiVideo.duration || getDanmakuMaxDuration());

                window.throttleSaveAnimeProgress(kazumiVideo.currentTime, kazumiVideo.duration);

            }

        });

        kazumiVideo.addEventListener("seeking", () => {

            window.seekMasterTimeline(kazumiVideo.currentTime);

        });

        kazumiVideo.addEventListener("seeked", () => {

            window.seekMasterTimeline(kazumiVideo.currentTime);

            if (!kazumiVideo.paused) {

                window.resumeDanmaku();

            }

        });

        kazumiVideo.addEventListener("ratechange", () => {

            applyDanmakuConfigToCSS();

        });

        kazumiVideo.addEventListener("ended", () => {

            window.pauseDanmaku();

            window.saveCurrentAnimeProgressNow();

        });

    }

    // 支援 iframe 播放器透過 postMessage 進行暫停/播放/時間軸雙向通知 (相容 Tampermonkey Bridge 與通用協議)

    window.addEventListener("message", (event) => {

        try {

            const data = event.data;

            if (!data) return;

            // 1. 優先處理來自 Tampermonkey Bridge 的高精度雙向回報

            if (data.source === 'kazumi_player_bridge') {

                if (data.type === 'wheel') {

                    if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

                    if (typeof window.adjustKazumiVolume === 'function') {

                        window.adjustKazumiVolume(data.delta || 5);

                    }

                    return;

                } else if (data.type === 'fullscreen') {

                    if (typeof window.toggleKazumiFullscreen === 'function') {

                        window.toggleKazumiFullscreen();

                    }

                    return;

                }

                const time = Number(data.currentTime);

                const duration = Number(data.duration) || getDanmakuMaxDuration();

                if (data.type === 'pause') {

                    window.pauseDanmaku();

                } else if (data.type === 'play') {

                    window.resumeDanmaku();

                } else if (data.type === 'timeupdate' || data.type === 'seek' || data.type === 'seeking' || data.type === 'seeked' || data.type === 'ready') {

                    if (!isNaN(time) && time >= 0) {

                        virtualDanmakuTime = time;

                        updateDanmakuTimeDisplay(time, duration);

                    }

                    if (data.type === 'seek' || data.type === 'seeked') {

                        // 彈幕隊列同步跳轉重對齊

                        if (currentDanmakuQueue && currentDanmakuQueue.length > 0) {

                            currentDanmakuQueue.forEach(item => {

                                item._fired = (item.numericTime < time);

                            });

                        }

                    }

                }

                return;

            }

            // 2. 通用 postMessage 協議 (Bilibili, YouTube, DPlayer, ArtPlayer)

            if (data === "pause" || data?.event === "pause" || data?.type === "pause" || data?.action === "pause") {

                window.pauseDanmaku();

            } else if (data === "play" || data?.event === "play" || data?.type === "play" || data?.action === "play") {

                window.resumeDanmaku();

            } else if (data?.type === "timeupdate" || data?.event === "timeupdate") {

                const curTime = typeof data.time === 'number' ? data.time : parseFloat(data.currentTime);

                if (!isNaN(curTime)) {

                    updateDanmakuTimeDisplay(curTime);

                    virtualDanmakuTime = curTime;

                }

            }

        } catch (e) {}

    });

    // 待命狀態精準判定：劇院處於待命模式且無正在播放的影片或串流

    window.isKazumiStandby = function() {

        const theaterModal = document.getElementById("animePlayerModal");

        if (!theaterModal) return false;

        const isOpen = theaterModal.classList.contains("show") || theaterModal.style.display === "block";

        if (!isOpen) return false;

        const placeholder = document.getElementById("kazumiTheaterPlaceholder");

        if (placeholder && placeholder.style.display !== "none") return true;

        const video = document.getElementById("kazumiVideoPlayer");

        const iframe = document.getElementById("kazumiIframePlayer");

        const isVideoActive = video && video.style.display !== "none" && video.src && !video.paused;

        const isIframeActive = iframe && iframe.style.display !== "none" && iframe.src;

        return !isVideoActive && !isIframeActive;

    };

    // 支援劇院快速鍵 (空白鍵暫停/繼續影片與彈幕、左右鍵快退/快進 5 秒，待命狀態僅保留按 F 全螢幕)

    document.addEventListener("keydown", (e) => {

        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";

        if (tag === "input" || tag === "textarea") return;

        const theaterModal = document.getElementById("animePlayerModal");

        const isOpen = theaterModal && theaterModal.classList.contains("show");

        if (!isOpen) return;

        // 待命狀態守衛：待命模式下全面禁止空白鍵暫停/播放、左右鍵跳轉、上下鍵調音量與 M 鍵靜音，【僅保留按 F 鍵全螢幕】

        if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) {

            if (e.code === "KeyF" || e.key === "f" || e.key === "F") {

                e.preventDefault();

                if (typeof window.toggleKazumiFullscreen === 'function') {

                    window.toggleKazumiFullscreen();

                }

            }

            return;

        }

        if (e.code === "Space" || e.key === " ") {

            e.preventDefault();

            if (typeof window.toggleMasterPlayPause === 'function') {

                window.toggleMasterPlayPause();

            }

        } else if (e.code === "ArrowLeft") {

            e.preventDefault();

            if (typeof window.jumpDanmakuRelative === 'function') {

                window.jumpDanmakuRelative(-5);

            }

        } else if (e.code === "ArrowRight") {

            e.preventDefault();

            if (typeof window.jumpDanmakuRelative === 'function') {

                window.jumpDanmakuRelative(5);

            }

        } else if (e.code === "KeyF" || e.key === "f" || e.key === "F") {

            e.preventDefault();

            if (typeof window.toggleKazumiFullscreen === 'function') {

                window.toggleKazumiFullscreen();

            }

        } else if (e.code === "ArrowUp") {

            e.preventDefault();

            if (typeof window.adjustKazumiVolume === 'function') {

                window.adjustKazumiVolume(5);

            }

        } else if (e.code === "ArrowDown") {

            e.preventDefault();

            if (typeof window.adjustKazumiVolume === 'function') {

                window.adjustKazumiVolume(-5);

            }

        } else if (e.code === "KeyM" || e.key === "m" || e.key === "M") {

            e.preventDefault();

            if (typeof window.toggleKazumiVolumeMute === 'function') {

                window.toggleKazumiVolumeMute();

            }

        }

    });

    // 綁定動漫劇院畫面滑鼠滾輪調音量 (滾輪上下各 5%，待命模式不響應)

    const screenContainer = document.getElementById("kazumiScreenContainer");

    if (screenContainer) {

        screenContainer.addEventListener('wheel', (e) => {

            const theaterModal = document.getElementById("animePlayerModal");

            const isOpen = theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block");

            const isFs = !!(document.fullscreenElement === screenContainer || document.webkitFullscreenElement === screenContainer);

            if (!isOpen && !isFs) return;

            if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

            e.preventDefault();

            const delta = e.deltaY < 0 ? 5 : -5;

            if (typeof window.adjustKazumiVolume === 'function') {

                window.adjustKazumiVolume(delta);

            }

            if (isFs && typeof window.onFullscreenMouseMove === 'function') {

                window.onFullscreenMouseMove();

            }

        }, { passive: false });

    }

    // 全螢幕上下感應區與中央事件代理層事件綁定

    initKazumiFullscreenInteractions();

    // 初始化劇院音量狀態

    if (typeof window.applyKazumiVolume === 'function') {

        window.applyKazumiVolume(false);

    }

});

// 全螢幕沉浸式互動感應區初始化

function initKazumiFullscreenInteractions() {

    const topHover = document.getElementById("kazumiFsTopHoverZone");

    const bottomHover = document.getElementById("kazumiFsBottomHoverZone");

    const screenOverlay = document.getElementById("kazumiFsScreenOverlay");

    const topBar = document.getElementById("kazumiFsTopBar");

    const timelineBar = document.getElementById("danmakuTimelineBar");

    const wakeUpAndResetTimer = (e) => {

        if (typeof window.onFullscreenMouseMove === 'function') {

            window.onFullscreenMouseMove(e);

        }

    };

    const handleHoverWheel = (e) => {

        const container = document.getElementById("kazumiScreenContainer");

        const theaterModal = document.getElementById("animePlayerModal");

        const isOpen = theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block");

        const isFs = container && (document.fullscreenElement === container || document.webkitFullscreenElement === container);

        if (!isOpen && !isFs) return;

        if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

        e.preventDefault();

        e.stopPropagation();

        const delta = e.deltaY < 0 ? 5 : -5;

        if (typeof window.adjustKazumiVolume === 'function') {

            window.adjustKazumiVolume(delta);

        }

        wakeUpAndResetTimer(e);

    };

    // 頂部與底部懸浮感應區：支援滑鼠滑入/移動喚醒

    [topHover, bottomHover].forEach(el => {

        if (!el) return;

        el.addEventListener("mousemove", wakeUpAndResetTimer);

        el.addEventListener("mouseenter", wakeUpAndResetTimer);

        el.addEventListener("wheel", handleHoverWheel, { passive: false });

    });

    const screenContainerEl = document.getElementById("kazumiScreenContainer");

    if (screenContainerEl) {

        screenContainerEl.addEventListener("mousemove", wakeUpAndResetTimer);

        screenContainerEl.addEventListener("mouseleave", () => {

            if (!screenContainerEl.classList.contains("is-standby")) {

                const drawer = document.getElementById("kazumiFsEpisodeDrawer");

                const drawerOpen = drawer && !drawer.classList.contains("d-none");

                if (!drawerOpen) {

                    screenContainerEl.classList.add("fs-controls-hidden");

                }

            }

        });

    }

    // 中央代理層：僅監聽真實滑鼠移動與滾輪，嚴禁監聽 mouseenter (避免 pointer-events auto 瞬間觸發虛假合成事件導致反覆抖動死循環)

    if (screenOverlay) {

        screenOverlay.addEventListener("mousemove", wakeUpAndResetTimer);

        screenOverlay.addEventListener("wheel", handleHoverWheel, { passive: false });

    }

    if (topBar) {

        topBar.addEventListener("mousemove", wakeUpAndResetTimer);

        topBar.addEventListener("mouseenter", wakeUpAndResetTimer);

        topBar.addEventListener("wheel", handleHoverWheel, { passive: false });

    }

    if (timelineBar) {

        timelineBar.addEventListener("mousemove", wakeUpAndResetTimer);

        timelineBar.addEventListener("mouseenter", () => {

            if (fsHideTimer) clearTimeout(fsHideTimer);

            if (screenContainerEl) screenContainerEl.classList.remove("fs-controls-hidden");

        });

        timelineBar.addEventListener("mouseleave", () => {

            startFsIdleTimer();

        });

        timelineBar.addEventListener("wheel", handleHoverWheel, { passive: false });

    }

    if (screenOverlay) {

        // 中央點擊切換播放/暫停，雙擊切換全螢幕

        let clickTimeout = null;

        screenOverlay.addEventListener("click", (e) => {

            const container = document.getElementById("kazumiScreenContainer");

            const theaterModal = document.getElementById("animePlayerModal");

            const isOpen = theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block");

            const isFs = container && (document.fullscreenElement === container || document.webkitFullscreenElement === container);

            if (!isFs && !isOpen) return;

            if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

            // 若點擊位置在畫面頂部 60px 或底部 85px (控制軸與時間列區域)，忽略中央代理層點擊，留給真實控制列

            const rect = screenOverlay.getBoundingClientRect();

            const y = e.clientY - rect.top;

            if (y > rect.height - 85 || y < 60) return;

            if (clickTimeout) {

                clearTimeout(clickTimeout);

                clickTimeout = null;

                return;

            }

            clickTimeout = setTimeout(() => {

                clickTimeout = null;

                if (typeof window.toggleDanmakuPlayPause === 'function') {

                    window.toggleDanmakuPlayPause();

                }

                wakeUpAndResetTimer();

            }, 250);

        });

        screenOverlay.addEventListener("dblclick", (e) => {

            e.preventDefault();

            if (clickTimeout) {

                clearTimeout(clickTimeout);

                clickTimeout = null;

            }

            if (typeof window.toggleKazumiFullscreen === 'function') {

                window.toggleKazumiFullscreen();

            }

        });

    }

    // 全域滾輪備援監聽：若處於全螢幕或劇院開啟狀態且滑鼠在播放器上方，攔截滾輪即時調整音量 (待命狀態不響應)

    window.addEventListener("wheel", (e) => {

        const container = document.getElementById("kazumiScreenContainer");

        const theaterModal = document.getElementById("animePlayerModal");

        const isOpen = theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block");

        const isFs = container && (document.fullscreenElement === container || document.webkitFullscreenElement === container);

        if (isFs) {

            if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

            e.preventDefault();

            const delta = e.deltaY < 0 ? 5 : -5;

            if (typeof window.adjustKazumiVolume === 'function') {

                window.adjustKazumiVolume(delta);

            }

            wakeUpAndResetTimer();

        } else if (isOpen && container) {

            const rect = container.getBoundingClientRect();

            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {

                if (typeof window.isKazumiStandby === 'function' && window.isKazumiStandby()) return;

                e.preventDefault();

                const delta = e.deltaY < 0 ? 5 : -5;

                if (typeof window.adjustKazumiVolume === 'function') {

                    window.adjustKazumiVolume(delta);

                }

            }

        }

    }, { passive: false });

}

// ==========================================

// Kazumi 彈幕開關與全域控制

// ==========================================

window.toggleDanmaku = function() {

    danmakuEnabled = !danmakuEnabled;

    const toggleBtn = document.getElementById("danmakuToggleBtn");

    const fsToggleBtn = document.getElementById("kazumiFsDanmakuToggleBtn");

    const fsStatusText = document.getElementById("kazumiFsDanmakuStatusText");

    if (toggleBtn) {

        toggleBtn.innerHTML = danmakuEnabled 

            ? `<i class="bi bi-chat-square-dots-fill text-warning"></i> 彈幕: 開` 

            : `<i class="bi bi-chat-square-dots text-muted"></i> 彈幕: 關`;

    }

    if (fsStatusText) {

        fsStatusText.textContent = danmakuEnabled ? "彈幕: 開" : "彈幕: 關";

    }

    if (fsToggleBtn) {

        if (danmakuEnabled) {

            fsToggleBtn.classList.remove("btn-outline-secondary");

            fsToggleBtn.classList.add("btn-outline-light");

        } else {

            fsToggleBtn.classList.remove("btn-outline-light");

            fsToggleBtn.classList.add("btn-outline-secondary");

        }

    }

    const overlay = document.getElementById("danmakuOverlay");

    if (overlay) overlay.style.display = danmakuEnabled ? "block" : "none";

    if (danmakuEnabled) {

        if (currentDanmakuQueue && currentDanmakuQueue.length > 0) {

            startDanmakuLoop();

        } else if (window.currentPlayingAnime) {

            startDanmakuStream(window.currentPlayingAnime.title, window.currentPlayingAnime.cid, window.currentPlayingAnime.ep);

        }

        showToast("已開啟彈幕顯示", "bi-chat-dots-fill text-warning");

    } else {

        showToast("已關閉彈幕顯示", "bi-chat-dots text-secondary");

    }

};

// ==========================================

// Kazumi 全螢幕與沈浸式浮動控制核心

// ==========================================

let fsHideTimer = null;

window.toggleKazumiFullscreen = function() {

    const container = document.getElementById("kazumiScreenContainer");

    if (!container) return;

    const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

    if (isFs) {

        if (document.exitFullscreen) {

            document.exitFullscreen().catch(() => {});

        } else if (document.webkitExitFullscreen) {

            document.webkitExitFullscreen();

        }

    } else {

        if (container.requestFullscreen) {

            container.requestFullscreen().catch(() => {});

        } else if (container.webkitRequestFullscreen) {

            container.webkitRequestFullscreen();

        } else if (container.mozRequestFullScreen) {

            container.mozRequestFullScreen();

        } else if (container.msRequestFullscreen) {

            container.msRequestFullscreen();

        }

    }

};

function handleFullscreenChange() {

    const container = document.getElementById("kazumiScreenContainer");

    if (!container) return;

    const isFs = !!(document.fullscreenElement === container || document.webkitFullscreenElement === container);

    const topBar = document.getElementById("kazumiFsTopBar");

    const danmakuBar = document.getElementById("kazumiFsDanmakuBar");

    const drawerBtn = document.getElementById("kazumiFsDrawerBtn");

    const icon = document.getElementById("kazumiFsIcon");

    const btnText = document.getElementById("kazumiFsBtnText");

    const titleEl = document.getElementById("kazumiFsTitle");

    const drawer = document.getElementById("kazumiFsEpisodeDrawer");

    if (isFs) {

        container.classList.add("is-fullscreen");

        if (topBar) {

            topBar.classList.remove("d-none");

            topBar.classList.add("d-flex");

        }

        if (danmakuBar) {

            danmakuBar.classList.remove("d-none");

            danmakuBar.classList.add("d-flex");

        }

        if (drawerBtn) drawerBtn.classList.remove("d-none");

        if (icon) icon.className = "bi bi-fullscreen-exit";

        if (btnText) btnText.textContent = "退出";

        const theaterTitle = document.getElementById("animePlayerTitle");

        if (titleEl && theaterTitle) {

            titleEl.textContent = theaterTitle.textContent || "動漫劇院播放中";

        }

        window.syncFullscreenEpisodeDrawer();

        startFsIdleTimer();

    } else {

        container.classList.remove("is-fullscreen");

        if (topBar) {

            topBar.classList.add("d-none");

            topBar.classList.remove("d-flex");

        }

        if (danmakuBar) {

            danmakuBar.classList.add("d-none");

            danmakuBar.classList.remove("d-flex");

        }

        if (drawer) drawer.classList.add("d-none");

        if (drawerBtn) drawerBtn.classList.add("d-none");

        if (icon) icon.className = "bi bi-fullscreen";

        if (btnText) btnText.textContent = "全螢幕";

        if (!container.classList.contains("is-standby")) {

            startFsIdleTimer();

        } else {

            container.classList.remove("fs-controls-hidden");

        }

    }

}

let lastFsMouseX = -1;

let lastFsMouseY = -1;

window.onFullscreenMouseMove = function(e) {

    const container = document.getElementById("kazumiScreenContainer");

    if (!container) return;

    // 嚴格座標位移判定：過濾 pointer-events 切換引起的虛假合成事件 (位移 < 3px 忽略，杜絕控制項反覆出現消失之抖動)

    if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number') {

        const dx = Math.abs(e.clientX - lastFsMouseX);

        const dy = Math.abs(e.clientY - lastFsMouseY);

        if (dx < 3 && dy < 3) {

            return;

        }

        lastFsMouseX = e.clientX;

        lastFsMouseY = e.clientY;

    }

    container.classList.remove("fs-controls-hidden");

    startFsIdleTimer();

};

function onFullscreenMouseMove(e) {

    window.onFullscreenMouseMove(e);

}

function startFsIdleTimer() {

    const container = document.getElementById("kazumiScreenContainer");

    if (!container) return;

    if (fsHideTimer) clearTimeout(fsHideTimer);

    // 待命狀態下絕不隱藏控制項與搜尋介面

    if (container.classList.contains("is-standby")) {

        container.classList.remove("fs-controls-hidden");

        return;

    }

    fsHideTimer = setTimeout(() => {

        const drawer = document.getElementById("kazumiFsEpisodeDrawer");

        const drawerOpen = drawer && !drawer.classList.contains("d-none");

        if (!drawerOpen && !container.classList.contains("is-standby")) {

            // 全螢幕或非全螢幕播放中，閒置 3 秒自動隱藏底部/頂部控制列，避免擋住影片！

            container.classList.add("fs-controls-hidden");

        }

    }, 3000);

}

// 快速選集抽屜切換

window.toggleFullscreenEpisodesDrawer = function(force) {

    const drawer = document.getElementById("kazumiFsEpisodeDrawer");

    if (!drawer) return;

    const shouldOpen = force !== undefined ? !!force : drawer.classList.contains("d-none");

    if (shouldOpen) {

        drawer.classList.remove("d-none");

        window.syncFullscreenEpisodeDrawer();

        const container = document.getElementById("kazumiScreenContainer");

        if (container) container.classList.remove("fs-controls-hidden");

    } else {

        drawer.classList.add("d-none");

        startFsIdleTimer();

    }

};

// 同步選集清單至全螢幕快速抽屜

window.syncFullscreenEpisodeDrawer = function() {

    const targetList = document.getElementById("kazumiFsEpisodeList");

    if (!targetList) return;

    targetList.innerHTML = "";

    const originButtons = document.querySelectorAll(".episode-list-container .ep-btn");

    if (originButtons.length === 0) {

        targetList.innerHTML = `<div class="text-white-50 small p-3 text-center">暫無選集清單</div>`;

        return;

    }

    originButtons.forEach(btn => {

        const itemBtn = document.createElement("button");

        const isActive = btn.classList.contains("active") || btn.classList.contains("btn-primary");

        itemBtn.className = `btn btn-sm text-start text-truncate ${isActive ? 'btn-primary active' : 'btn-outline-secondary text-white'}`;

        itemBtn.innerHTML = btn.innerHTML;

        itemBtn.title = btn.title || btn.textContent.trim();

        itemBtn.onclick = () => {

            btn.click();

            window.syncFullscreenEpisodeDrawer();

        };

        targetList.appendChild(itemBtn);

    });

};

// 全螢幕即時彈幕發送

window.sendFsDanmaku = function() {

    const input = document.getElementById("kazumiFsDanmakuInput");

    if (!input) return;

    const val = input.value.trim();

    if (!val) return;

    createBulletDanmaku(val, "#22c55e");

    input.value = "";

    showToast(`彈幕已在全螢幕發送：「${val}」`, "bi-chat-dots-fill text-success");

};

// ==========================================

// B. Tachimanga 條漫閱讀器與全網檢索模組

// ==========================================

let currentMangaZoom = 1.0;

let mangaState = {

    currentManga: null,      // { id, title, cover, author }

    chapters: [],            // [ { id, title, index } ]

    currentChapterIdx: -1,   // 目前閱讀章節索引

    pages: [],               // 目前章節所有頁面 URL

    searchResults: []        // 最近搜尋結果

};

// ==========================================

// 全域立體書架管理輔助函式 (相容 acg.html 與 index.html)

// ==========================================

if (!window.getMangaBookshelf) {

    window.getMangaBookshelf = function() {

        try {

            const data = localStorage.getItem('web_library_manga_bookshelf');

            if (data !== null) {

                let parsed = JSON.parse(data);

                if (Array.isArray(parsed)) {

                    const dummyTitles = ["航海王", "葬送的芙莉蓮", "咒術迴戰", "鏈鋸人", "鬼滅之刃"];

                    return parsed.filter(b => !dummyTitles.includes(b.title));

                }

            }

        } catch (e) {}

        return [];

    };

}

if (!window.saveMangaBookshelf) {

    window.saveMangaBookshelf = function(list) {

        localStorage.setItem('web_library_manga_bookshelf', JSON.stringify(list));

        if (typeof window.renderMangaBookshelf === 'function') {

            window.renderMangaBookshelf();

        }

    };

}

if (!window.toggleMangaBookshelfItem) {

    window.toggleMangaBookshelfItem = function(title, cover, btnEl) {

        if (!title) return;

        let shelf = window.getMangaBookshelf();

        const exists = shelf.some(b => b.title === title);

        if (exists) {

            shelf = shelf.filter(b => b.title !== title);

            window.saveMangaBookshelf(shelf);

            if (btnEl) {

                btnEl.className = "btn btn-xs btn-outline-primary rounded-pill px-2";

                btnEl.innerHTML = `<i class="bi bi-bookmark-plus"></i> + 放進書架`;

                btnEl.title = "將此漫畫放進條漫立體書架";

            }

            if (typeof showToast === 'function') {

                showToast(`已將《${title}》移出條漫書架`, "bi-trash text-warning");

            }

        } else {

            shelf.unshift({

                title: title.trim(),

                cover: cover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=400&q=80",

                tag: "條漫"

            });

            window.saveMangaBookshelf(shelf);

            if (btnEl) {

                btnEl.className = "btn btn-xs btn-primary rounded-pill px-2";

                btnEl.innerHTML = `<i class="bi bi-bookmark-check-fill"></i> 已在書架`;

                btnEl.title = "已在條漫書架中，點擊可移出";

            }

            if (typeof showToast === 'function') {

                showToast(`🎉 成功將《${title}》收藏進條漫立體書架！`, "bi-star-fill text-warning");

            }

        }

        if (typeof window.renderMangaBookshelf === 'function') {

            window.renderMangaBookshelf();

        }

    };

}

if (!window.getNovelBookshelf) {

    window.getNovelBookshelf = function() {

        try {

            const data = localStorage.getItem('web_library_novel_bookshelf');

            if (data !== null) {

                let parsed = JSON.parse(data);

                if (Array.isArray(parsed)) {

                    const dummyTitles = ["關於我轉生變成史萊姆這檔事", "無職轉生", "刀劍神域", "Re:從零開始的異世界生活"];

                    return parsed.filter(b => !dummyTitles.includes(b.title));

                }

            }

        } catch (e) {}

        return [];

    };

}

if (!window.saveNovelBookshelf) {

    window.saveNovelBookshelf = function(list) {

        localStorage.setItem('web_library_novel_bookshelf', JSON.stringify(list));

        if (typeof window.renderNovelBookshelf === 'function') {

            window.renderNovelBookshelf();

        }

    };

}

// ============================================================

// 3D 擬真立體書架全域核心引擎 (支援琴鍵式相鄰波浪聯動 & 3D 抽書起伏)

// ============================================================

function bindBookshelfWaveEffect(bookEl) {

    if (!bookEl || typeof gsap === 'undefined') return;

    bookEl.addEventListener('mouseenter', () => {

        // 1. 當前書本：3D 拔起 + 微傾角 + 深度投影

        gsap.to(bookEl, {

            y: -22,

            scale: 1.1,

            rotateY: -8,

            rotateZ: -1.5,

            duration: 0.35,

            ease: "back.out(2)",

            overwrite: "auto"

        });

        // 2. 琴鍵式相鄰波浪：前一本微幅起伏

        const prev = bookEl.previousElementSibling;

        if (prev && prev.classList.contains("bookshelf-book")) {

            gsap.to(prev, {

                y: -8,

                scale: 1.03,

                rotateY: -3,

                duration: 0.28,

                ease: "power1.out",

                overwrite: "auto"

            });

        }

        // 3. 琴鍵式相鄰波浪：後一本微幅起伏

        const next = bookEl.nextElementSibling;

        if (next && next.classList.contains("bookshelf-book")) {

            gsap.to(next, {

                y: -8,

                scale: 1.03,

                rotateY: 3,

                duration: 0.28,

                ease: "power1.out",

                overwrite: "auto"

            });

        }

    });

    bookEl.addEventListener('mouseleave', () => {

        // 當前書本彈簧復位

        gsap.to(bookEl, {

            y: 0,

            scale: 1,

            rotateY: 0,

            rotateZ: 0,

            duration: 0.35,

            ease: "power2.out",

            overwrite: "auto"

        });

        // 前一本復位

        const prev = bookEl.previousElementSibling;

        if (prev && prev.classList.contains("bookshelf-book")) {

            gsap.to(prev, {

                y: 0,

                scale: 1,

                rotateY: 0,

                duration: 0.3,

                ease: "power2.out",

                overwrite: "auto"

            });

        }

        // 後一本復位

        const next = bookEl.nextElementSibling;

        if (next && next.classList.contains("bookshelf-book")) {

            gsap.to(next, {

                y: 0,

                scale: 1,

                rotateY: 0,

                duration: 0.3,

                ease: "power2.out",

                overwrite: "auto"

            });

        }

    });

}

// 渲染條漫立體書架

window.renderMangaBookshelf = function() {

    const grid = document.getElementById("mangaBookshelfGrid");

    if (!grid) return;

    const shelf = window.getMangaBookshelf();

    grid.innerHTML = "";

    if (shelf.length === 0) {

        grid.innerHTML = `

            <div class="text-white-50 py-5 small text-center w-100 d-flex flex-column align-items-center justify-content-center">

                <i class="bi bi-collection fs-1 text-primary opacity-50 mb-2"></i>

                <div class="fw-semibold fs-6 text-white mb-1">條漫書架目前尚無藏書</div>

                <div class="text-white-50 small mb-3">可在上方搜尋漫畫或選集抽屜點擊「+ 放進書架」，即可將喜愛的作品陳列於此！</div>

                <button class="btn btn-sm btn-outline-primary rounded-pill px-3" onclick="openMangaSearchModal('')">

                    <i class="bi bi-search me-1"></i> 前往搜尋漫畫

                </button>

            </div>

        `;

        return;

    }

    shelf.forEach(book => {

        const bookEl = document.createElement("div");

        bookEl.className = "bookshelf-book";

        bookEl.innerHTML = `

            <span class="bookshelf-badge bg-primary text-white">${escapeHtml(book.tag || '條漫')}</span>

            <button type="button" class="bookshelf-remove-btn" title="移出書架" onclick="event.stopPropagation(); removeBookFromMangaShelf('${escapeHtml(book.title)}')">✕</button>

            <div class="bookshelf-book-cover-wrap">

                <img src="${escapeHtml(book.cover)}" alt="${escapeHtml(book.title)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=400&q=80'">

            </div>

            <div class="bookshelf-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>

            <div class="bookshelf-book-sub">點擊開卷</div>

        `;

        bookEl.onclick = () => {

            if (typeof window.openMangaSearchModal === 'function') {

                window.openMangaSearchModal(book.title);

            }

        };

        bindBookshelfWaveEffect(bookEl);

        grid.appendChild(bookEl);

    });

    if (typeof gsap !== 'undefined') {

        gsap.from("#mangaBookshelfGrid .bookshelf-book", {

            y: 35,

            opacity: 0,

            rotateY: -15,

            scale: 0.9,

            stagger: 0.06,

            duration: 0.45,

            ease: "back.out(1.5)"

        });

    }

};

window.removeBookFromMangaShelf = function(title) {

    let shelf = window.getMangaBookshelf();

    shelf = shelf.filter(b => b.title !== title);

    window.saveMangaBookshelf(shelf);

    if (typeof showToast === 'function') {

        showToast(`已將《${title}》移出條漫書架`, "bi-trash text-warning");

    }

};

// 渲染小說立體書架 (智能區分本機上傳與線上搜尋開卷)

window.renderNovelBookshelf = function() {

    const grid = document.getElementById("novelBookshelfGrid");

    if (!grid) return;

    const shelf = window.getNovelBookshelf ? window.getNovelBookshelf() : [];

    grid.innerHTML = "";

    if (shelf.length === 0) {

        grid.innerHTML = `

            <div class="text-muted py-5 small text-center w-100 d-flex flex-column align-items-center justify-content-center">

                <i class="bi bi-book-half fs-1 text-success opacity-50 mb-2"></i>

                <div class="fw-semibold fs-6 text-dark mb-1">小說書房目前尚無藏書</div>

                <div class="text-muted small mb-3">可在上方搜尋輕小說或點擊「上傳電子書」，即可將喜愛的作品陳列於此！</div>

                <div class="d-flex gap-2">

                    <button class="btn btn-sm btn-outline-success rounded-pill px-3" onclick="openNovelSearchModal('')">

                        <i class="bi bi-search me-1"></i> 搜尋線上小說

                    </button>

                    <button class="btn btn-sm btn-success rounded-pill px-3" onclick="document.getElementById('novelLocalFileInput').click()">

                        <i class="bi bi-upload me-1"></i> 上傳本機小說

                    </button>

                </div>

            </div>

        `;

        return;

    }

    shelf.forEach(book => {

        const bookEl = document.createElement("div");

        bookEl.className = "bookshelf-book";

        const isLocal = !!(book.isLocal || book.source === 'local' || (book.tag && book.tag.includes('本機')));

        const badgeClass = isLocal ? "bg-info text-dark fw-bold" : "bg-success text-white";

        const badgeText = isLocal ? "本機上傳" : "線上輕小說";

        const subText = isLocal ? "點擊開卷 (本機)" : "點擊翻閱 (線上)";

        bookEl.innerHTML = `

            <span class="bookshelf-badge ${badgeClass}">${escapeHtml(book.tag || badgeText)}</span>

            <button type="button" class="bookshelf-remove-btn" title="移出書房" onclick="event.stopPropagation(); removeBookFromNovelShelf('${escapeHtml(book.title)}')">✕</button>

            <div class="bookshelf-book-cover-wrap">

                <img src="${escapeHtml(book.cover)}" alt="${escapeHtml(book.title)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=400&q=80'">

            </div>

            <div class="bookshelf-book-title text-dark" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>

            <div class="bookshelf-book-sub ${isLocal ? 'text-primary fw-semibold' : ''}">${subText}</div>

        `;

        bookEl.onclick = async () => {

            if (isLocal) {

                // 本機電子書開卷邏輯：自 IndexedDB 讀取完整章節

                const bookId = book.id || ('local_' + book.title.replace(/\s+/g, '_'));

                let localData = await getLocalNovelFromDB(bookId);

                

                // 若未找到，嘗試按標題查詢

                if (!localData && window.novelState && window.novelState.currentNovel && window.novelState.currentNovel.title === book.title) {

                    localData = { title: book.title, chapters: window.novelState.chapters };

                }

                if (localData && Array.isArray(localData.chapters) && localData.chapters.length > 0) {

                    loadLocalBookIntoReader(localData.title, localData.chapters, bookId);

                    // 切換為閱讀中畫面

                    const placeholder = document.getElementById("legadoPlaceholder");

                    if (placeholder) placeholder.style.display = "none";

                    const readingArea = document.getElementById("novelReadingArea");

                    if (readingArea) readingArea.style.display = "block";

                } else {

                    showToast(`⚠️ 未在本地快取找到《${book.title}》的內容，請點擊「上傳電子書」重新載入！`, "bi-exclamation-triangle text-warning");

                }

            } else {

                // 線上小說：開啟搜尋與選集抽屜

                if (typeof window.openNovelSearchModal === 'function') {

                    window.openNovelSearchModal(book.title);

                }

            }

        };

        if (typeof bindBookshelfWaveEffect === 'function') {

            bindBookshelfWaveEffect(bookEl);

        }

        grid.appendChild(bookEl);

    });

    if (typeof gsap !== 'undefined') {

        gsap.from("#novelBookshelfGrid .bookshelf-book", {

            y: 35,

            opacity: 0,

            rotateY: -15,

            scale: 0.9,

            stagger: 0.06,

            duration: 0.45,

            ease: "back.out(1.5)"

        });

    }

};

window.removeBookFromNovelShelf = function(title) {

    let shelf = window.getNovelBookshelf();

    shelf = shelf.filter(b => b.title !== title);

    window.saveNovelBookshelf(shelf);

    if (typeof showToast === 'function') {

        showToast(`已將《${title}》移出小說書房`, "bi-trash text-warning");

    }

};

// 監聽 Modal 開啟自動觸發書架渲染與 GSAP 彈性擺入

document.addEventListener("DOMContentLoaded", () => {

    const mangaModal = document.getElementById("mangaReaderModal");

    if (mangaModal) {

        mangaModal.addEventListener('shown.bs.modal', () => {

            if (typeof window.renderMangaBookshelf === 'function') {

                window.renderMangaBookshelf();

            }

        });

    }

    const novelModal = document.getElementById("novelReaderModal");

    if (novelModal) {

        novelModal.addEventListener('shown.bs.modal', () => {

            if (typeof window.renderNovelBookshelf === 'function') {

                window.renderNovelBookshelf();

            }

        });

    }

    // 初次載入渲染待命書架

    setTimeout(() => {

        if (typeof window.renderMangaBookshelf === 'function') window.renderMangaBookshelf();

        if (typeof window.renderNovelBookshelf === 'function') window.renderNovelBookshelf();

    }, 200);

});

if (!window.toggleNovelBookshelfItem) {

    window.toggleNovelBookshelfItem = function(title, cover, btnEl) {

        if (!title) return;

        let shelf = window.getNovelBookshelf();

        const exists = shelf.some(b => b.title === title);

        if (exists) {

            shelf = shelf.filter(b => b.title !== title);

            window.saveNovelBookshelf(shelf);

            if (btnEl) {

                btnEl.className = "btn btn-xs btn-outline-success rounded-pill px-2";

                btnEl.innerHTML = `<i class="bi bi-bookmark-plus"></i> + 放進書房`;

                btnEl.title = "將此小說放進立體書房";

            }

            if (typeof showToast === 'function') {

                showToast(`已將《${title}》移出小說書房`, "bi-trash text-warning");

            }

        } else {

            shelf.unshift({

                title: title.trim(),

                cover: cover || "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=400&q=80",

                tag: "小說"

            });

            window.saveNovelBookshelf(shelf);

            if (btnEl) {

                btnEl.className = "btn btn-xs btn-success rounded-pill px-2";

                btnEl.innerHTML = `<i class="bi bi-bookmark-check-fill"></i> 已在書房`;

                btnEl.title = "已在小說書房中，點擊可移出";

            }

            if (typeof showToast === 'function') {

                showToast(`🎉 成功將《${title}》收藏進小說立體書房！`, "bi-star-fill text-warning");

            }

        }

        if (typeof window.renderNovelBookshelf === 'function') {

            window.renderNovelBookshelf();

        }

    };

}

// 開啟 Tachimanga 閱覽器

window.openTachimangaReader = function(title = "", pages = []) {

    if (title && title !== "漫畫閱覽器" && title.trim() !== "") {

        // 如果帶有漫畫名稱，直接喚起搜尋與選集抽屜

        openMangaSearchModal(title.trim());

        return;

    }

    const titleEl = document.getElementById("mangaModalTitle");

    const indicatorEl = document.getElementById("mangaPageIndicator");

    const chapterBadge = document.getElementById("mangaCurrentChapterBadge");

    const wrapper = document.getElementById("mangaPageWrapper");

    if (titleEl) titleEl.textContent = mangaState.currentManga ? mangaState.currentManga.title : "Tachimanga 條漫閱覽器";

    if (chapterBadge) {

        chapterBadge.textContent = mangaState.currentChapterIdx >= 0 && mangaState.chapters[mangaState.currentChapterIdx]

            ? mangaState.chapters[mangaState.currentChapterIdx].title

            : "尚未選擇章節";

    }

    currentMangaZoom = 1.0;

    if (wrapper) {

        wrapper.style.transform = `scale(${currentMangaZoom})`;

    }

    if (!pages || pages.length === 0) {

        if (!mangaState.pages || mangaState.pages.length === 0) {

            renderMangaStandby();

        }

    } else {

        renderMangaWaterfall(pages);

    }

    updateMangaNavButtons();

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("mangaReaderModal"));

    modal.show();

};

// 渲染純淨待命搜尋畫面 (3D 擬真立體書架)

function renderMangaStandby() {

    const indicatorEl = document.getElementById("mangaPageIndicator");

    const wrapper = document.getElementById("mangaPageWrapper");

    if (indicatorEl) indicatorEl.textContent = "";

    if (wrapper) {

        wrapper.innerHTML = `

            <div class="bookshelf-container py-4 text-start w-100" id="tachimangaPlaceholder">

                <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2 px-2">

                    <div class="d-flex align-items-center gap-2">

                        <i class="bi bi-collection-fill fs-4 text-primary"></i>

                        <div>

                            <h5 class="fw-bold text-white mb-0">條漫立體藏書閣</h5>

                            <span class="text-white-50 small">點選書本立即開卷 · 搜尋漫畫即可收入書架</span>

                        </div>

                    </div>

                    <div class="d-flex gap-2">

                        <div class="input-group input-group-sm" style="width: 260px;">

                            <input type="text" id="mangaStandbySearchInput" class="form-control bg-dark text-white border-secondary" placeholder="搜尋漫畫加入書架..." onkeydown="if(event.key==='Enter') searchMangaFromStandby()">

                            <button class="btn btn-primary" type="button" onclick="searchMangaFromStandby()"><i class="bi bi-search"></i> 搜尋</button>

                        </div>

                    </div>

                </div>

                <!-- 書架層架 -->

                <div class="bookshelf-shelf">

                    <div class="bookshelf-books-row" id="mangaBookshelfGrid">

                        <!-- 由 JS 動態注入 3D 漫畫書本 -->

                    </div>

                    <div class="bookshelf-plank"></div>

                </div>

                

                <!-- 漫畫閱讀歷史紀錄區 -->

                <div id="mangaRecentHistoryBox" class="mt-2 text-start w-100" style="display: none;"></div>

            </div>

        `;

        if (typeof window.renderMangaBookshelf === 'function') {

            window.renderMangaBookshelf();

        }

        if (typeof window.renderMangaHistoryStandby === 'function') {

            window.renderMangaHistoryStandby();

        }

    }

}

// 待命畫面觸發搜尋

window.searchMangaFromStandby = function() {

    const input = document.getElementById("mangaStandbySearchInput");

    const q = input ? input.value.trim() : "";

    if (!q) {

        showToast("請輸入漫畫作品名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    openMangaSearchModal(q);

};

// 頂部導航列觸發搜尋

window.searchMangaFromHeader = function(val) {

    const q = (val || "").trim();

    if (!q) {

        showToast("請輸入欲搜尋的漫畫名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    openMangaSearchModal(q);

};

// 開啟漫畫來源與選集抽屜

window.openMangaSearchModal = function(defaultKeyword = "") {

    const input = document.getElementById("mangaDrawerKeywordInput");

    if (input && defaultKeyword) input.value = defaultKeyword;

    const modalEl = document.getElementById("mangaSourceModal");

    if (modalEl) {

        bootstrap.Modal.getOrCreateInstance(modalEl).show();

    }

    if (defaultKeyword) {

        searchMangaFromDrawer(defaultKeyword);

    }

};

// 在抽屜中進行漫畫搜尋

window.searchMangaFromDrawer = async function(keyword) {

    const q = (keyword || (document.getElementById("mangaDrawerKeywordInput") ? document.getElementById("mangaDrawerKeywordInput").value : "")).trim();

    if (!q) {

        showToast("請輸入漫畫名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    const container = document.getElementById("mangaSearchResultsContainer");

    const summaryBox = document.getElementById("mangaSelectedSummaryBox");

    if (summaryBox) summaryBox.classList.add("d-none");

    if (container) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <div class="spinner-border text-primary spinner-border-sm mb-2" role="status"></div>

                <div>正在全網漫畫庫檢索《${escapeHtml(q)}》...</div>

            </div>

        `;

    }

    try {

        const res = await fetch(`/api/manga/search?q=${encodeURIComponent(q)}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        mangaState.searchResults = data.results || [];

        renderMangaSearchResults(mangaState.searchResults, q);

    } catch (err) {

        console.error("漫畫搜尋失敗：", err);

        if (container) {

            container.innerHTML = `<div class="text-danger text-center py-4"><i class="bi bi-exclamation-triangle"></i> 搜尋失敗：${escapeHtml(err.message)}</div>`;

        }

    }

};

// 渲染漫畫搜尋結果清單

function renderMangaSearchResults(results, q) {

    const container = document.getElementById("mangaSearchResultsContainer");

    if (!container) return;

    if (!results || results.length === 0) {

        container.innerHTML = `

            <div class="text-secondary text-center py-4">

                <i class="bi bi-inbox fs-3 d-block mb-2"></i>

                未找到與「${escapeHtml(q)}」相符的漫畫，請更換關鍵字嘗試。

            </div>

        `;

        return;

    }

    container.innerHTML = "";

    results.forEach(m => {

        const card = document.createElement("div");

        card.className = "p-2 rounded-3 bg-black bg-opacity-40 border border-secondary d-flex align-items-center gap-3";

        const coverUrl = m.cover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=300&q=80";

        const statusTagId = `mangaBgmStatusTxt_${m.id || Math.random().toString(36).substr(2, 6)}`;

        const isCopy = (m.source === 'CopyManga' || (m.id && m.id.startsWith('copy_')));

        const sourceName = m.source || (isCopy ? 'CopyManga' : '包子漫畫');

        const sourceBadgeHtml = isCopy 

            ? `<span class="badge bg-primary bg-opacity-75 text-light px-2 py-0 border border-primary border-opacity-50" style="font-size: 0.72rem; vertical-align: middle;"><i class="bi bi-c-circle me-1"></i>CopyManga</span>`

            : `<span class="badge bg-warning bg-opacity-75 text-dark px-2 py-0 border border-warning border-opacity-50" style="font-size: 0.72rem; vertical-align: middle;"><i class="bi bi-box-seam me-1"></i>包子漫畫</span>`;

        const inShelf = (typeof window.getMangaBookshelf === 'function') && window.getMangaBookshelf().some(b => b.title === m.title);

        const shelfBtnClass = inShelf ? "btn-primary" : "btn-outline-primary";

        const shelfBtnText = inShelf ? '<i class="bi bi-bookmark-check-fill"></i> 已在書架' : '<i class="bi bi-bookmark-plus"></i> + 放進書架';

        const shelfBtnTitle = inShelf ? '已在條漫書架中，點擊可移出' : '將此漫畫放進條漫立體書架';

        card.innerHTML = `

            <img src="${escapeHtml(coverUrl)}" class="rounded shadow-sm" alt="${escapeHtml(m.title)}" style="width: 54px; height: 72px; object-fit: cover;" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=300&q=80'">

            <div class="overflow-hidden flex-grow-1">

                <div class="d-flex align-items-center gap-2 mb-1">

                    <h6 class="fw-bold text-white mb-0 text-truncate" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</h6>

                    ${sourceBadgeHtml}

                </div>

                <div class="small text-truncate mb-1" style="color: #cbd5e1;">

                    <span class="text-primary me-2"><i class="bi bi-person"></i> ${escapeHtml(m.author || "未知作者")}</span>

                    <span class="text-muted" style="font-size: 0.75rem;">來源：${escapeHtml(sourceName)}</span>

                </div>

                <div class="small text-truncate" style="font-size: 0.8rem; color: #94a3b8;">${escapeHtml(m.brief || "全網精選條漫資源")}</div>

            </div>

            <div class="d-flex flex-column align-items-end gap-1 flex-shrink-0">

                <div class="d-flex align-items-center gap-1">

                    <button class="btn btn-xs ${shelfBtnClass} rounded-pill px-2" onclick="toggleMangaBookshelfItem('${escapeHtml(m.title)}', '${escapeHtml(coverUrl)}', this)" title="${shelfBtnTitle}">

                        ${shelfBtnText}

                    </button>

                    <div class="dropdown d-inline-block">

                        <button class="btn btn-xs btn-outline-info dropdown-toggle rounded-pill px-2 bookmark-watch-status-btn" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="檢視或更改 Bangumi 閱讀狀態">

                            <i class="bi bi-book"></i> <span id="${statusTagId}">辨識中...</span>

                        </button>

                        <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end shadow-sm" style="font-size: 0.8rem; z-index: 1060;">

                            <li><h6 class="dropdown-header small" style="color: #38bdf8 !important;">Bangumi 閱讀狀態</h6></li>

                            <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(m.title)}', 3, true, '${statusTagId}'); return false;"><i class="bi bi-play-circle text-success me-1"></i> 已在讀</a></li>

                            <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(m.title)}', 1, true, '${statusTagId}'); return false;"><i class="bi bi-heart text-danger me-1"></i> 想讀</a></li>

                            <li><a class="dropdown-item" href="#" onclick="applyBangumiStatusChange('${escapeHtml(m.title)}', 2, true, '${statusTagId}'); return false;"><i class="bi bi-check2-circle text-primary me-1"></i> 已讀過</a></li>

                        </ul>

                    </div>

                </div>

                <button class="btn btn-sm btn-outline-primary text-nowrap rounded-pill px-3 w-100" onclick="selectManga('${escapeHtml(m.id)}', '${escapeHtml(m.title)}', '${escapeHtml(coverUrl)}', '${escapeHtml(m.author || '')}', '${escapeHtml(m.alias || '')}', '${escapeHtml(sourceName)}')">

                    <i class="bi bi-list-ol"></i> 選集

                </button>

            </div>

        `;

        container.appendChild(card);

        setTimeout(() => { checkAndRenderBangumiStatus(m.title, 1, statusTagId); }, 20);

    });

}

// 選擇一部漫畫並載入章節列表 (支援別名與繁簡智慧自癒)

window.selectManga = async function(mangaId, title, cover, author, alias = '', source = '') {

    mangaState.currentManga = { id: mangaId, title, cover, author, alias, source };

    const summaryBox = document.getElementById("mangaSelectedSummaryBox");

    const container = document.getElementById("mangaSearchResultsContainer");

    const isCopy = source === 'CopyManga' || (mangaId && mangaId.startsWith('copy_'));

    const badgeHtml = isCopy 

        ? `<span class="badge bg-primary bg-opacity-75 text-light px-2 py-0 border border-primary border-opacity-50" style="font-size: 0.72rem; vertical-align: middle;"><i class="bi bi-c-circle me-1"></i>CopyManga</span>`

        : `<span class="badge bg-warning bg-opacity-75 text-dark px-2 py-0 border border-warning border-opacity-50" style="font-size: 0.72rem; vertical-align: middle;"><i class="bi bi-box-seam me-1"></i>包子漫畫</span>`;

    if (summaryBox) {

        summaryBox.classList.remove("d-none");

        summaryBox.classList.add("d-flex");

        document.getElementById("mangaSelectedCover").src = cover;

        document.getElementById("mangaSelectedTitle").textContent = title;

        document.getElementById("mangaSelectedAuthor").innerHTML = `${escapeHtml(author || "漫畫原作")} <span class="ms-2">${badgeHtml}</span>`;

        document.getElementById("mangaSelectedChapterCount").textContent = "正在載入話數...";

    }

    if (container) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <div class="spinner-border text-primary spinner-border-sm mb-2" role="status"></div>

                <div>正在載入《${escapeHtml(title)}》的章節清單...</div>

            </div>

        `;

    }

    try {

        const res = await fetch(`/api/manga/chapters?mangaId=${encodeURIComponent(mangaId)}&title=${encodeURIComponent(title || '')}&alias=${encodeURIComponent(alias || '')}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        mangaState.chapters = data.chapters || [];

        const countBadge = document.getElementById("mangaSelectedChapterCount");

        if (countBadge) countBadge.textContent = mangaState.chapters.length > 0 ? `共 ${mangaState.chapters.length} 話` : "暫無在線話數";

        renderMangaChaptersGrid(mangaId, mangaState.chapters);

    } catch (err) {

        console.error("載入章節失敗：", err);

        if (container) {

            container.innerHTML = `<div class="text-danger text-center py-4"><i class="bi bi-exclamation-triangle"></i> 載入章節失敗：${escapeHtml(err.message)}</div>`;

        }

    }

};

// 回到漫畫搜尋結果列表

window.backToMangaSearchResults = function() {

    const summaryBox = document.getElementById("mangaSelectedSummaryBox");

    if (summaryBox) summaryBox.classList.add("d-none");

    renderMangaSearchResults(mangaState.searchResults, "");

};

// 渲染章節選集按鈕網格

function renderMangaChaptersGrid(mangaId, chapters) {

    const container = document.getElementById("mangaSearchResultsContainer");

    if (!container) return;

    if (!chapters || chapters.length === 0) {

        container.innerHTML = `

            <div class="text-secondary text-center py-5">

                <i class="bi bi-shield-lock text-warning fs-3 mb-2 d-block"></i>

                <div class="fw-bold mb-1 text-light">暫無可用線上章節</div>

                <div class="small text-muted mb-3">此作品可能受源站官方 APP 權限保護或線上暫無庫存，建議返回更換關鍵字或點擊其他備援條目。</div>

                <button class="btn btn-sm btn-outline-info rounded-pill px-3" onclick="backToMangaSearchResults()">

                    <i class="bi bi-arrow-left"></i> 返回搜尋結果

                </button>

            </div>

        `;

        return;

    }

    const grid = document.createElement("div");

    grid.className = "d-flex flex-wrap gap-2 p-1";

    chapters.forEach((ch, idx) => {

        const btn = document.createElement("button");

        btn.className = `btn btn-sm ${mangaState.currentChapterIdx === idx ? 'btn-primary' : 'btn-outline-light'} text-truncate`;

        btn.style.minWidth = "88px";

        btn.style.maxWidth = "130px";

        btn.textContent = ch.title || `第 ${idx + 1} 話`;

        btn.title = ch.title;

        btn.onclick = () => loadMangaChapter(mangaId, ch.id, ch.title, idx);

        grid.appendChild(btn);

    });

    container.innerHTML = "";

    container.appendChild(grid);

}

// 載入指定章節並在條漫閱讀器中垂直瀑布流展開

window.loadMangaChapter = async function(mangaId, chapterId, chapterTitle, chapterIndex) {

    mangaState.currentChapterIdx = chapterIndex;

    // 關閉來源抽屜

    const sourceModalEl = document.getElementById("mangaSourceModal");

    if (sourceModalEl) {

        const sourceModal = bootstrap.Modal.getInstance(sourceModalEl);

        if (sourceModal) sourceModal.hide();

    }

    // 開啟閱讀器 Modal

    const readerModal = bootstrap.Modal.getOrCreateInstance(document.getElementById("mangaReaderModal"));

    readerModal.show();

    // 更新頂部資訊

    const titleEl = document.getElementById("mangaModalTitle");

    const chapterBadge = document.getElementById("mangaCurrentChapterBadge");

    const indicatorEl = document.getElementById("mangaPageIndicator");

    const wrapper = document.getElementById("mangaPageWrapper");

    if (titleEl && mangaState.currentManga) titleEl.textContent = mangaState.currentManga.title;

    if (chapterBadge) chapterBadge.textContent = chapterTitle || `第 ${chapterIndex + 1} 話`;

    if (indicatorEl) indicatorEl.textContent = "載入中...";

    // 紀錄漫畫閱讀歷史

    if (mangaState.currentManga) {

        window.saveMangaReadHistory(mangaId, mangaState.currentManga.title, mangaState.currentManga.cover, chapterTitle, chapterIndex);

    }

    if (wrapper) {

        wrapper.innerHTML = `

            <div class="text-center py-5 my-5 text-secondary">

                <div class="spinner-border text-primary mb-3" style="width: 2.5rem; height: 2.5rem;" role="status"></div>

                <h5 class="fw-bold text-white mb-1">正在載入【${escapeHtml(chapterTitle)}】條漫長圖...</h5>

                <p class="small text-secondary">穿透防盜鏈並建立垂直無縫畫布</p>

            </div>

        `;

    }

    updateMangaNavButtons();

    try {

        const res = await fetch(`/api/manga/pages?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        mangaState.pages = data.pages || [];

        renderMangaWaterfall(mangaState.pages);

    } catch (err) {

        console.error("載入漫畫頁面失敗：", err);

        if (wrapper) {

            wrapper.innerHTML = `

                <div class="text-center py-5 my-5 text-danger">

                    <i class="bi bi-exclamation-triangle fs-1 d-block mb-3"></i>

                    <h5 class="fw-bold mb-1">條漫載入失敗</h5>

                    <p class="small text-secondary mb-3">${escapeHtml(err.message)}</p>

                    <button class="btn btn-outline-light btn-sm rounded-pill px-3" onclick="loadMangaChapter('${escapeHtml(mangaId)}', '${escapeHtml(chapterId)}', '${escapeHtml(chapterTitle)}', ${chapterIndex})">

                        <i class="bi bi-arrow-repeat"></i> 重試

                    </button>

                </div>

            `;

        }

    }

};

// 渲染條漫垂直瀑布流長圖

function renderMangaWaterfall(pages) {

    const wrapper = document.getElementById("mangaPageWrapper");

    const indicatorEl = document.getElementById("mangaPageIndicator");

    const scrollBox = document.getElementById("mangaScrollContainer");

    if (!wrapper) return;

    wrapper.innerHTML = "";

    if (!pages || pages.length === 0) {

        wrapper.innerHTML = `<div class="text-secondary text-center py-5">本話暫無可顯示的條漫長圖</div>`;

        if (indicatorEl) indicatorEl.textContent = "";

        return;

    }

    pages.forEach((src, idx) => {

        const img = document.createElement("img");

        img.className = "manga-page-img w-100 d-block shadow-sm";

        img.style.margin = "0 auto";

        img.style.maxWidth = "820px";

        img.src = src;

        img.alt = `Page ${idx + 1}`;

        img.setAttribute("referrerpolicy", "no-referrer"); // 繞過大部分防盜鏈

        img.loading = idx < 3 ? "eager" : "lazy"; // 前三張立即載入，其餘滾動懶載入

        wrapper.appendChild(img);

    });

    if (indicatorEl) indicatorEl.textContent = `第 1 頁 / 共 ${pages.length} 頁`;

    if (scrollBox) {

        scrollBox.scrollTop = 0;

        scrollBox.onscroll = () => {

            const imgs = wrapper.querySelectorAll("img.manga-page-img");

            if (imgs.length === 0) return;

            const containerTop = scrollBox.scrollTop;

            const containerHeight = scrollBox.clientHeight;

            const viewCenter = containerTop + containerHeight / 2;

            let currentPage = 1;

            imgs.forEach((img, index) => {

                const imgTop = img.offsetTop;

                const imgBottom = imgTop + img.offsetHeight;

                if (viewCenter >= imgTop && viewCenter <= imgBottom) {

                    currentPage = index + 1;

                }

            });

            if (indicatorEl) {

                indicatorEl.textContent = `第 ${currentPage} 頁 / 共 ${pages.length} 頁`;

            }

        };

    }

}

// 上一話

window.prevMangaChapter = function() {

    if (!mangaState.currentManga || mangaState.currentChapterIdx <= 0) {

        showToast("已經是第一話了！", "bi-info-circle text-primary");

        return;

    }

    const targetIdx = mangaState.currentChapterIdx - 1;

    const targetCh = mangaState.chapters[targetIdx];

    if (targetCh) {

        loadMangaChapter(mangaState.currentManga.id, targetCh.id, targetCh.title, targetIdx);

    }

};

// 下一話

window.nextMangaChapter = function() {

    if (!mangaState.currentManga || mangaState.currentChapterIdx >= mangaState.chapters.length - 1) {

        showToast("已經是最新一話了！", "bi-info-circle text-primary");

        return;

    }

    const targetIdx = mangaState.currentChapterIdx + 1;

    const targetCh = mangaState.chapters[targetIdx];

    if (targetCh) {

        loadMangaChapter(mangaState.currentManga.id, targetCh.id, targetCh.title, targetIdx);

    }

};

// 切換章節選單抽屜

window.openMangaChapterPicker = function() {

    if (!mangaState.currentManga) {

        openMangaSearchModal();

        return;

    }

    selectManga(mangaState.currentManga.id, mangaState.currentManga.title, mangaState.currentManga.cover, mangaState.currentManga.author);

    const modalEl = document.getElementById("mangaSourceModal");

    if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();

};

// 更新上一話/下一話按鈕狀態

function updateMangaNavButtons() {

    const prevBtn = document.getElementById("mangaPrevChapterBtn");

    const nextBtn = document.getElementById("mangaNextChapterBtn");

    if (prevBtn) {

        prevBtn.disabled = mangaState.currentChapterIdx <= 0;

    }

    if (nextBtn) {

        nextBtn.disabled = mangaState.currentChapterIdx < 0 || mangaState.currentChapterIdx >= mangaState.chapters.length - 1;

    }

}

window.zoomManga = function(delta) {

    currentMangaZoom = Math.min(1.8, Math.max(0.6, currentMangaZoom + delta));

    const wrapper = document.getElementById("mangaPageWrapper");

    if (wrapper) wrapper.style.transform = `scale(${currentMangaZoom})`;

};

window.resetZoomManga = function() {

    currentMangaZoom = 1.0;

    const wrapper = document.getElementById("mangaPageWrapper");

    if (wrapper) wrapper.style.transform = `scale(1.0)`;

};

// 關閉當前漫畫，退回待命搜尋狀態 (不關閉閱覽器 Modal)

window.closeCurrentManga = function() {

    mangaState.currentManga = null;

    mangaState.chapters = [];

    mangaState.currentChapterIdx = -1;

    mangaState.pages = [];

    

    const titleEl = document.getElementById("mangaModalTitle");

    if (titleEl) titleEl.textContent = "Tachimanga 條漫閱覽器";

    

    const chapterBadge = document.getElementById("mangaCurrentChapterBadge");

    if (chapterBadge) chapterBadge.textContent = "尚未選擇章節";

    

    const indicatorEl = document.getElementById("mangaPageIndicator");

    if (indicatorEl) indicatorEl.textContent = "";

    const headerSearch = document.getElementById("mangaHeaderSearchInput");

    if (headerSearch) headerSearch.value = "";

    renderMangaStandby();

    updateMangaNavButtons();

    showToast("已關閉當前漫畫，回到待命狀態", "bi-x-circle text-primary");

};

// ==========================================

// --- C. Legado 沉浸小說閱讀器全功能引擎 ---

// ==========================================

let novelState = {

    currentNovel: null,       // { id, title, author, cover, intro, category }

    chapters: [],             // [ { id, title, index } ]

    currentChapterIdx: -1,    // 目前閱讀章節索引

    currentParagraphs: [],    // 目前章節段落

    searchResults: [],        // 最近搜尋結果

    theme: 'sepia',           // 'sepia' | 'white' | 'dark'

    fontSize: 18,             // 14 ~ 28 px

    customTextColor: (function() {

        try { return localStorage.getItem('novel_text_color') || null; } catch (e) { return null; }

    })()                      // 使用者自訂正文字體顏色

};

// 待命畫面快速搜尋推薦點擊

window.quickSearchNovel = function(keyword) {

    openNovelSearchModal(keyword);

};

// 待命畫面觸發搜尋

window.searchNovelFromStandby = function() {

    const input = document.getElementById("novelStandbySearchInput");

    const q = input ? input.value.trim() : "";

    if (!q) {

        showToast("請輸入小說作品或作者名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    openNovelSearchModal(q);

};

// 頂部導航列觸發搜尋

window.searchNovelFromHeader = function(val) {

    const q = (val || "").trim();

    if (!q) {

        showToast("請輸入欲搜尋的小說名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    openNovelSearchModal(q);

};

// 開啟小說搜尋與選集抽屜 Modal

window.openNovelSearchModal = function(defaultKeyword = "") {

    const input = document.getElementById("novelDrawerKeywordInput");

    if (input && defaultKeyword) input.value = defaultKeyword;

    updateNovelSourcePills();

    const modalEl = document.getElementById("novelSourceModal");

    if (modalEl) {

        bootstrap.Modal.getOrCreateInstance(modalEl).show();

    }

    if (defaultKeyword) {

        searchNovelFromDrawer(defaultKeyword);

    }

};

// ============================================================

// Legado 輕小說多書源切換與檢索核心 (Wenku8 輕小說文庫 vs Bilinovel 嗶哩輕小說)

// ============================================================

let currentNovelSource = localStorage.getItem("novel_preferred_source") || "wenku8";

function updateNovelSourcePills() {

    const pillWenku = document.getElementById("sourcePill-wenku8");

    const pillBili = document.getElementById("sourcePill-bilinovel");

    const badge = document.getElementById("currentNovelSourceBadge");

    if (currentNovelSource === "bilinovel") {

        if (pillBili) pillBili.className = "btn btn-sm btn-success rounded-pill px-3 py-1 fw-bold novel-source-pill";

        if (pillWenku) pillWenku.className = "btn btn-sm btn-outline-light rounded-pill px-3 py-1 text-white novel-source-pill";

        if (badge) badge.textContent = "當前：嗶哩輕小說";

    } else {

        if (pillWenku) pillWenku.className = "btn btn-sm btn-success rounded-pill px-3 py-1 fw-bold novel-source-pill";

        if (pillBili) pillBili.className = "btn btn-sm btn-outline-light rounded-pill px-3 py-1 text-white novel-source-pill";

        if (badge) badge.textContent = "當前：輕小說文庫";

    }

}

window.setNovelSource = function(src) {

    currentNovelSource = src || "wenku8";

    localStorage.setItem("novel_preferred_source", currentNovelSource);

    updateNovelSourcePills();

    const sourceName = currentNovelSource === "bilinovel" ? "Bilinovel 嗶哩輕小說" : "Wenku8 輕小說文庫";

    showToast(`📚 已切換至書源【${sourceName}】`, "bi-journal-bookmark-fill text-success");

    // 重新檢索當前輸入框關鍵字或重整推薦

    const input = document.getElementById("novelDrawerKeywordInput");

    const kw = input ? input.value.trim() : "";

    searchNovelFromDrawer(kw);

};

window.onNovelSourceChanged = window.setNovelSource;

// 在抽屜中進行小說檢索（支援 Wenku8 與 Bilinovel 多書源）

window.searchNovelFromDrawer = async function(keyword) {

    const q = (keyword !== undefined && keyword !== null 

        ? keyword 

        : (document.getElementById("novelDrawerKeywordInput") ? document.getElementById("novelDrawerKeywordInput").value : "")).trim();

    const selectEl = document.getElementById("novelSourceSelect");

    const source = (selectEl && selectEl.value) ? selectEl.value : currentNovelSource;

    const sourceName = source === "bilinovel" ? "Bilinovel 嗶哩輕小說" : "Wenku8 輕小說文庫";

    const container = document.getElementById("novelSearchResultsContainer");

    const summaryBox = document.getElementById("novelSelectedSummaryBox");

    if (summaryBox) {

        summaryBox.classList.remove("d-flex");

        summaryBox.classList.add("d-none");

    }

    if (container) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <div class="spinner-border text-success spinner-border-sm mb-2" role="status"></div>

                <div>正在【${sourceName}】檢索${q ? `《${escapeHtml(q)}》` : '精選輕小說'}...</div>

            </div>

        `;

    }

    let results = [];

    try {

        const resp = await fetch(`/api/novel/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`);

        if (resp.ok) {

            const json = await resp.json();

            if (json.success && Array.isArray(json.results) && json.results.length > 0) {

                results = json.results;

            }

        }

    } catch (err) {

        console.warn("後端小說 API 未啟動或回應異常：", err);

    }

    novelState.searchResults = results;

    renderNovelSearchResults(results);

};

// 渲染小說搜尋結果清單 (包含書源標籤)

function renderNovelSearchResults(novels) {

    const container = document.getElementById("novelSearchResultsContainer");

    if (!container) return;

    if (!novels || novels.length === 0) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <i class="bi bi-journal-x fs-2 d-block mb-2 text-warning opacity-75"></i>

                <div>未找到相關輕小說作品，請嘗試其他關鍵字</div>

            </div>

        `;

        return;

    }

    container.innerHTML = novels.map(n => {

        const sourceBadge = (n.source === 'bilinovel' || (n.sourceName && n.sourceName.includes('嗶哩')))

            ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle small me-1">📚 Bilinovel</span>'

            : '<span class="badge bg-success-subtle text-success border border-success-subtle small me-1">📖 Wenku8</span>';

        const inShelf = (typeof window.getNovelBookshelf === 'function') && window.getNovelBookshelf().some(b => b.title === n.title);

        const shelfBtnClass = inShelf ? "btn-success" : "btn-outline-success";

        const shelfBtnText = inShelf ? '<i class="bi bi-bookmark-check-fill me-1"></i> 已在書房' : '<i class="bi bi-bookmark-plus me-1"></i> + 放進書房';

        const shelfBtnTitle = inShelf ? '已在小說書房中，點擊可移出' : '將此小說放進立體書房';

        return `

        <div class="card bg-black bg-opacity-50 border-secondary mb-3 hover-shadow transition-all">

            <div class="row g-0 align-items-center">

                <div class="col-3 col-sm-2 text-center p-2">

                    <img src="${escapeHtml(n.cover || 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=200')}" 

                         alt="${escapeHtml(n.title)}" 

                         class="img-fluid rounded-2 shadow-sm" 

                         style="max-height: 105px; object-fit: cover;"

                         onerror="this.src='https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=200'">

                </div>

                <div class="col-9 col-sm-10">

                    <div class="card-body py-2 pe-3 ps-1">

                        <div class="d-flex align-items-center justify-content-between mb-1">

                            <h6 class="card-title fw-bold text-white mb-0 text-truncate">

                                ${sourceBadge}

                                ${escapeHtml(n.title)}

                            </h6>

                            <span class="badge bg-success-subtle text-success small">${escapeHtml(n.status || '完結')}</span>

                        </div>

                        <div class="small mb-1" style="color: #cbd5e1;">

                            <span><i class="bi bi-person text-success"></i> ${escapeHtml(n.author || '佚名')}</span>

                            <span class="mx-2">·</span>

                            <span><i class="bi bi-tag text-success"></i> ${escapeHtml(n.category || '輕小說')}</span>

                            <span class="mx-2">·</span>

                            <span><i class="bi bi-list-ol text-success"></i> 共 ${n.chapterCount || '多'} 章</span>

                        </div>

                        <p class="card-text small text-truncate mb-2" style="max-width: 480px; color: #94a3b8;">${escapeHtml(n.intro || '')}</p>

                        <div class="d-flex align-items-center gap-2 flex-wrap">

                            <button class="btn btn-sm btn-success rounded-pill px-3" onclick="selectNovel('${escapeHtml(n.id)}', '${escapeHtml(n.title)}', '${escapeHtml(n.cover || '')}', '${escapeHtml(n.author || '')}', '${escapeHtml(n.intro || '')}')">

                                <i class="bi bi-book-half me-1"></i> 開始閱讀 / 選集

                            </button>

                            <button class="btn btn-sm ${shelfBtnClass} rounded-pill px-3" onclick="toggleNovelBookshelfItem('${escapeHtml(n.title)}', '${escapeHtml(n.cover || '')}', this)" title="${shelfBtnTitle}">

                                ${shelfBtnText}

                            </button>

                        </div>

                    </div>

                </div>

            </div>

        </div>

        `;

    }).join('');

}

// 選擇某部小說並載入章節目錄（支援多分卷標題展示）

window.selectNovel = async function(novelId, title, cover, author, intro = '') {

    const selectEl = document.getElementById("novelSourceSelect");

    const source = selectEl ? selectEl.value : currentNovelSource;

    novelState.currentNovel = { id: novelId, title, cover, author, intro, source };

    // 顯示上方摘要卡

    const summaryBox = document.getElementById("novelSelectedSummaryBox");

    if (summaryBox) {

        summaryBox.classList.remove("d-none");

        summaryBox.classList.add("d-flex");

        const coverEl = document.getElementById("novelSelectedCover");

        const titleEl = document.getElementById("novelSelectedTitle");

        const authorEl = document.getElementById("novelSelectedAuthor");

        const introEl = document.getElementById("novelSelectedIntro");

        if (coverEl) coverEl.src = cover || 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=200';

        if (titleEl) titleEl.textContent = title;

        if (authorEl) authorEl.textContent = author || '佚名';

        if (introEl) introEl.textContent = intro;

    }

    const container = document.getElementById("novelSearchResultsContainer");

    if (container) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <div class="spinner-border text-success spinner-border-sm mb-2" role="status"></div>

                <div>正在載入《${escapeHtml(title)}》分卷與章節目錄...</div>

            </div>

        `;

    }

    let chapters = [];

    try {

        const resp = await fetch(`/api/novel/chapters?novelId=${encodeURIComponent(novelId)}&title=${encodeURIComponent(title)}&source=${encodeURIComponent(source)}`);

        if (resp.ok) {

            const json = await resp.json();

            if (json.success && Array.isArray(json.chapters) && json.chapters.length > 0) {

                chapters = json.chapters;

            }

        }

    } catch (err) {

        console.warn("載入後端小說章節失敗：", err);

    }

    novelState.chapters = chapters;

    const countEl = document.getElementById("novelSelectedChapterCount");

    if (countEl) countEl.textContent = `共 ${chapters.length} 章`;

    renderNovelChapterList(chapters, novelId, title);

};

// 渲染抽屜內的章節按鈕清單（高對比度徽章修正）

function renderNovelChapterList(chapters, novelId, title) {

    const container = document.getElementById("novelSearchResultsContainer");

    if (!container) return;

    if (!chapters || chapters.length === 0) {

        container.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <i class="bi bi-journal-x fs-2 d-block mb-2 text-warning opacity-75"></i>

                <div class="text-white fw-bold">很抱歉，此書源暫無《${escapeHtml(title)}》的章節資料</div>

                <div class="small text-white-50 mt-1">請嘗試切換上方其他書源或檢索其他小說作品。</div>

            </div>

        `;

        return;

    }

    container.innerHTML = `

        <div class="d-flex align-items-center justify-content-between mb-2">

            <span class="small text-secondary"><i class="bi bi-list-check"></i> 點選章節立即進入閱讀：</span>

            <span class="badge bg-secondary border border-secondary text-white">${chapters.length} 個章節</span>

        </div>

        <div class="row g-2">

            ${chapters.map((ch, idx) => `

                <div class="col-12 col-sm-6">

                    <button class="btn btn-sm btn-outline-secondary w-100 text-start text-truncate py-2 px-3 d-flex align-items-center justify-content-between chapter-select-btn ${novelState.currentChapterIdx === idx ? 'border-success text-success bg-success bg-opacity-10 active' : ''}" 

                            onclick="loadNovelChapter('${escapeHtml(novelId)}', '${escapeHtml(ch.id)}', ${idx}, '${escapeHtml(title)}')">

                        <span class="text-truncate">${escapeHtml(ch.title)}</span>

                        <i class="bi bi-chevron-right small opacity-50 ms-2"></i>

                    </button>

                </div>

            `).join('')}

        </div>

    `;

}

// 抽屜中返回搜尋結果列表

window.backToNovelSearchResults = function() {

    const summaryBox = document.getElementById("novelSelectedSummaryBox");

    if (summaryBox) {

        summaryBox.classList.remove("d-flex");

        summaryBox.classList.add("d-none");

    }

    if (novelState.searchResults && novelState.searchResults.length > 0) {

        renderNovelSearchResults(novelState.searchResults);

    }

};

// 核心：載入指定小說的特定章節正文（具備本地備援正文生成引擎）

window.loadNovelChapter = async function(novelId, chapterId, chapterIdx, novelTitle = '') {

    showToast(`正在翻閱《${novelTitle || (novelState.currentNovel ? novelState.currentNovel.title : '小說')}》...`, "bi-book-half text-success");

    // 關閉抽屜 Modal (如果有開啟)

    const drawerEl = document.getElementById("novelSourceModal");

    if (drawerEl) {

        const drawerInstance = bootstrap.Modal.getInstance(drawerEl);

        if (drawerInstance) drawerInstance.hide();

    }

    // 確保小說閱讀器 Modal 處於開啟狀態

    const readerEl = document.getElementById("novelReaderModal");

    if (readerEl) {

        bootstrap.Modal.getOrCreateInstance(readerEl).show();

    }

    const titleEl = document.getElementById("novelBookTitle");

    const badgeEl = document.getElementById("novelChapterBadge");

    const headingEl = document.getElementById("novelChapterHeading");

    const paragraphsEl = document.getElementById("novelChapterParagraphs");

    const readingArea = document.getElementById("novelReadingArea");

    const placeholder = document.getElementById("legadoPlaceholder");

    if (placeholder) placeholder.style.display = "none";

    const histBox = document.getElementById("animeRecentHistoryBox");

    if (histBox) histBox.style.display = "none";

    const listContainer = document.querySelector(".episode-list-container");

    if (listContainer) listContainer.style.display = "flex";

    const screenCont = document.getElementById("kazumiScreenContainer");

    if (screenCont) {

        screenCont.classList.remove("is-standby");

        if (typeof startFsIdleTimer === 'function') startFsIdleTimer();

    }

    if (readingArea) readingArea.style.display = "block";

    if (paragraphsEl) {

        paragraphsEl.innerHTML = `

            <div class="text-center py-5 text-secondary">

                <div class="spinner-border text-success spinner-border-sm mb-2" role="status"></div>

                <div>正在載入章節正文...</div>

            </div>

        `;

    }

    let loadedParagraphs = null;

    let loadedChapterTitle = '';

    const selectEl = document.getElementById("novelSourceSelect");

    const source = selectEl ? selectEl.value : currentNovelSource;

    try {

        const resp = await fetch(`/api/novel/content?novelId=${encodeURIComponent(novelId)}&chapterId=${encodeURIComponent(chapterId)}&title=${encodeURIComponent(novelTitle)}&source=${encodeURIComponent(source)}`);

        if (resp.ok) {

            const json = await resp.json();

            if (json.success && Array.isArray(json.paragraphs) && json.paragraphs.length > 0) {

                loadedParagraphs = json.paragraphs;

                loadedChapterTitle = json.title;

            }

        }

    } catch (err) {

        console.warn("後端章節內容獲取失敗：", err);

    }

    if (!loadedParagraphs || loadedParagraphs.length === 0) {

        loadedParagraphs = [

            `【提示】當前書源暫無《${novelTitle || '本作品'}》第 ${chapterIdx + 1} 章之正文內容。`,

            `可能原因：該小說尚未收錄於目前所選的書源資料庫中，或來源端暫時維護中。`,

            `建議您可以嘗試切換頂部之小說書源（如 輕小說文庫 / 嗶哩輕小說）再次檢索。`

        ];

        loadedChapterTitle = `章節正文暫缺`;

    }

    novelState.currentChapterIdx = chapterIdx;

    novelState.currentParagraphs = loadedParagraphs;

    const effectiveTitle = novelTitle || (novelState.currentNovel ? novelState.currentNovel.title : '沉浸小說閱讀');

    if (titleEl) titleEl.textContent = effectiveTitle;

    if (badgeEl) badgeEl.textContent = loadedChapterTitle || `第 ${chapterIdx + 1} 章`;

    if (headingEl) headingEl.textContent = loadedChapterTitle || `第 ${chapterIdx + 1} 章`;

    if (paragraphsEl) {

        paragraphsEl.innerHTML = loadedParagraphs.map(p => `

            <p class="mb-4 text-justify" style="text-indent: 2em; line-height: 2.2;">${escapeHtml(p)}</p>

        `).join('');

        // 立即套用使用者已保存的自訂字色

        const savedColor = novelState.customTextColor || (function() {

            try { return localStorage.getItem('novel_text_color'); } catch (e) { return null; }

        })();

        if (savedColor && typeof window.setNovelCustomTextColor === 'function') {

            window.setNovelCustomTextColor(savedColor);

        }

    }

    // 捲動至頂部

    const bodyWrapper = document.getElementById("novelBodyWrapper");

    if (bodyWrapper) bodyWrapper.scrollTop = 0;

    updateNovelNavButtons();

};

// 切換上一章 / 下一章

window.switchNovelChapter = function(delta) {

    if (!novelState.currentNovel || !novelState.chapters || novelState.chapters.length === 0) {

        showToast("尚未選擇小說或章節", "bi-info-circle text-warning");

        return;

    }

    const nextIdx = novelState.currentChapterIdx + delta;

    if (nextIdx < 0) {

        showToast("已經是第一章囉！", "bi-info-circle text-info");

        return;

    }

    if (nextIdx >= novelState.chapters.length) {

        showToast("已閱讀至最新章節！", "bi-check-all text-success");

        return;

    }

    if (novelState.currentNovel.isLocal) {

        loadLocalNovelChapter(nextIdx);

        return;

    }

    const targetCh = novelState.chapters[nextIdx];

    if (targetCh) {

        loadNovelChapter(novelState.currentNovel.id, targetCh.id, nextIdx, novelState.currentNovel.title);

    }

};

// 開啟選集目錄抽屜

window.openNovelChapterPicker = function() {

    if (!novelState.currentNovel) {

        openNovelSearchModal();

        return;

    }

    if (novelState.currentNovel.isLocal) {

        const summaryBox = document.getElementById("novelSelectedSummaryBox");

        if (summaryBox) {

            summaryBox.classList.remove("d-none");

            summaryBox.classList.add("d-flex");

            const titleEl = document.getElementById("novelSelectedTitle");

            const authorEl = document.getElementById("novelSelectedAuthor");

            const introEl = document.getElementById("novelSelectedIntro");

            const coverEl = document.getElementById("novelSelectedCover");

            if (coverEl) coverEl.src = 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=200';

            if (titleEl) titleEl.textContent = novelState.currentNovel.title;

            if (authorEl) authorEl.textContent = "本機電子書";

            if (introEl) introEl.textContent = novelState.currentNovel.intro;

        }

        renderLocalNovelChapterList();

        const modalEl = document.getElementById("novelSourceModal");

        if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();

        return;

    }

    selectNovel(novelState.currentNovel.id, novelState.currentNovel.title, novelState.currentNovel.cover, novelState.currentNovel.author, novelState.currentNovel.intro);

    const modalEl = document.getElementById("novelSourceModal");

    if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();

};

// 渲染本機電子書抽屜章節目錄

function renderLocalNovelChapterList() {

    const container = document.getElementById("novelSearchResultsContainer");

    if (!container) return;

    const chapters = novelState.chapters || [];

    const countEl = document.getElementById("novelSelectedChapterCount");

    if (countEl) countEl.textContent = `共 ${chapters.length} 章`;

    container.innerHTML = `

        <div class="row g-2">

            ${chapters.map((ch, idx) => `

                <div class="col-12 col-md-6 col-lg-4">

                    <button class="btn btn-sm ${novelState.currentChapterIdx === idx ? 'btn-success fw-bold text-white shadow-sm' : 'btn-outline-light text-white-50'} w-100 text-truncate text-start px-3 py-2 border rounded-3" 

                            onclick="selectLocalNovelChapter(${idx})" 

                            title="${escapeHtml(ch.title)}">

                        <i class="bi ${novelState.currentChapterIdx === idx ? 'bi-bookmark-check-fill text-white' : 'bi-file-text'} me-2"></i>

                        <span>${escapeHtml(ch.title)}</span>

                    </button>

                </div>

            `).join('')}

        </div>

    `;

}

window.selectLocalNovelChapter = function(idx) {

    loadLocalNovelChapter(idx);

    const modalEl = document.getElementById("novelSourceModal");

    if (modalEl) {

        const m = bootstrap.Modal.getInstance(modalEl);

        if (m) m.hide();

    }

};

// 關閉當前小說，回到待命搜尋狀態

window.closeCurrentNovel = function() {

    novelState.currentNovel = null;

    novelState.chapters = [];

    novelState.currentChapterIdx = -1;

    novelState.currentParagraphs = [];

    const fileInput = document.getElementById("novelLocalFileInput");

    if (fileInput) fileInput.value = "";

    const titleEl = document.getElementById("novelBookTitle");

    if (titleEl) titleEl.textContent = "沉浸小說閱讀";

    const badgeEl = document.getElementById("novelChapterBadge");

    if (badgeEl) badgeEl.textContent = "尚未選擇章節";

    const headerSearch = document.getElementById("novelHeaderSearchInput");

    if (headerSearch) headerSearch.value = "";

    const standbySearch = document.getElementById("novelStandbySearchInput");

    if (standbySearch) standbySearch.value = "";

    const placeholder = document.getElementById("legadoPlaceholder");

    if (placeholder) placeholder.style.display = "block";

    const readingArea = document.getElementById("novelReadingArea");

    if (readingArea) readingArea.style.display = "none";

    const paragraphsEl = document.getElementById("novelChapterParagraphs");

    if (paragraphsEl) paragraphsEl.innerHTML = "";

    updateNovelNavButtons();

    showToast("已關閉當前小說，回到待命狀態", "bi-x-circle text-success");

};

// ==========================================

// 本機電子書解析引擎 (.txt / .epub)

// ==========================================

window.handleNovelFileUpload = async function(file) {

    if (!file) return;

    const fileName = file.name;

    const ext = fileName.slice((fileName.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();

    if (ext !== 'txt' && ext !== 'epub') {

        showToast("僅支援上傳 .txt 或 .epub 格式的電子書！", "bi-exclamation-triangle-fill text-warning");

        return;

    }

    showToast(`正在讀取並解析電子書《${fileName}》...`, "bi-hourglass-split text-info");

    const bookTitle = fileName.replace(/\.[^/.]+$/, "");

    if (ext === 'txt') {

        parseAndLoadTxtBook(file, bookTitle);

    } else if (ext === 'epub') {

        await parseAndLoadEpubBook(file, bookTitle);

    }

};

// TXT 電子書智慧正則切分

function parseAndLoadTxtBook(file, bookTitle) {

    const reader = new FileReader();

    reader.onload = function(e) {

        const content = e.target.result;

        if (!content || !content.trim()) {

            showToast("此電子書檔案為空！", "bi-x-circle text-danger");

            return;

        }

        // 章節正則匹配：支援 第X章、第X回、第X卷、第X節、Chapter X 等

        const chapterRegex = /(?:^|\r?\n)[\t \u3000]*(第[\s0-9一二三四五六七八九十百千]+[章回節卷集話篇][^\r\n]*|Chapter\s*\d+[^\r\n]*)/gi;

        const matches = [];

        let m;

        while ((m = chapterRegex.exec(content)) !== null) {

            matches.push({

                title: m[1].trim(),

                index: m.index

            });

        }

        const chapters = [];

        if (matches.length > 0) {

            // 前言或序章

            if (matches[0].index > 0) {

                const introText = content.slice(0, matches[0].index).trim();

                if (introText) {

                    chapters.push({

                        id: 'ch_0',

                        title: '前言 / 序章',

                        index: 0,

                        paragraphs: splitTextIntoParagraphs(introText)

                    });

                }

            }

            for (let i = 0; i < matches.length; i++) {

                const start = matches[i].index;

                const end = (i + 1 < matches.length) ? matches[i + 1].index : content.length;

                const rawChText = content.slice(start, end).trim();

                const firstLineEnd = rawChText.indexOf('\n');

                const chBody = firstLineEnd !== -1 ? rawChText.slice(firstLineEnd).trim() : rawChText;

                chapters.push({

                    id: 'ch_' + chapters.length,

                    title: matches[i].title,

                    index: chapters.length,

                    paragraphs: splitTextIntoParagraphs(chBody || rawChText)

                });

            }

        } else {

            // 無明顯章節標記，按每 4000 字智慧切分

            const chunkSize = 4000;

            let start = 0;

            let chNum = 1;

            while (start < content.length) {

                let end = Math.min(start + chunkSize, content.length);

                if (end < content.length) {

                    const newlineIdx = content.indexOf('\n', end);

                    if (newlineIdx !== -1 && newlineIdx - end < 500) {

                        end = newlineIdx;

                    }

                }

                const chunkText = content.slice(start, end).trim();

                chapters.push({

                    id: 'ch_' + chapters.length,

                    title: `第 ${chNum} 部分`,

                    index: chapters.length,

                    paragraphs: splitTextIntoParagraphs(chunkText)

                });

                start = end;

                chNum++;

            }

        }

        loadLocalBookIntoReader(bookTitle, chapters);

    };

    reader.readAsText(file, "UTF-8");

}

function splitTextIntoParagraphs(text) {

    return text.split(/\r?\n+/)

        .map(p => p.trim())

        .filter(p => p.length > 0);

}

// EPUB 電子書解析

async function parseAndLoadEpubBook(file, bookTitle) {

    if (typeof JSZip === 'undefined') {

        showToast("正在載入 EPUB 解密元件，請稍候...", "bi-hourglass-split text-info");

        try {

            await new Promise((resolve, reject) => {

                const s = document.createElement("script");

                s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

                s.onload = resolve;

                s.onerror = reject;

                document.head.appendChild(s);

            });

        } catch (e) {

            showToast("載入 EPUB 解析器失敗，請確認網路！", "bi-x-circle text-danger");

            return;

        }

    }

    try {

        const zip = await JSZip.loadAsync(file);

        const htmlFiles = [];

        zip.forEach((relativePath, zipEntry) => {

            if (/\.(xhtml|html|htm)$/i.test(zipEntry.name) && !zipEntry.name.includes('cover')) {

                htmlFiles.push(zipEntry);

            }

        });

        htmlFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        if (htmlFiles.length === 0) {

            showToast("此 EPUB 檔案未包含可辨識章節！", "bi-exclamation-triangle text-warning");

            return;

        }

        const chapters = [];

        for (let i = 0; i < htmlFiles.length; i++) {

            const rawHtml = await htmlFiles[i].async("text");

            const parser = new DOMParser();

            const doc = parser.parseFromString(rawHtml, "text/html");

            const h = doc.querySelector("h1, h2, h3, title");

            const title = (h ? h.textContent.trim() : "") || `第 ${i + 1} 節`;

            const pEls = doc.querySelectorAll("p");

            let paragraphs = [];

            if (pEls.length > 0) {

                pEls.forEach(p => {

                    const txt = p.textContent.trim();

                    if (txt) paragraphs.push(txt);

                });

            } else {

                paragraphs = splitTextIntoParagraphs(doc.body.textContent || "");

            }

            if (paragraphs.length > 0) {

                chapters.push({

                    id: 'ch_' + chapters.length,

                    title: title,

                    index: chapters.length,

                    paragraphs: paragraphs

                });

            }

        }

        if (chapters.length === 0) {

            showToast("無法解析此 EPUB 章節正文！", "bi-x-circle text-danger");

            return;

        }

        loadLocalBookIntoReader(bookTitle, chapters);

    } catch (err) {

        console.error("EPUB 解析失敗:", err);

        showToast("解析 EPUB 檔案失敗，請確認檔案未損壞", "bi-x-circle text-danger");

    }

}

// 載入本機書籍到閱讀器

// ============================================================

// 本機小說 IndexedDB 永續存儲引擎 (突破 localStorage 5MB 限制)

// ============================================================

const LOCAL_NOVEL_DB_NAME = 'WebLibraryLocalNovels';

const LOCAL_NOVEL_STORE_NAME = 'novel_chapters';

function getLocalNovelDB() {

    return new Promise((resolve, reject) => {

        if (!window.indexedDB) {

            resolve(null);

            return;

        }

        const req = indexedDB.open(LOCAL_NOVEL_DB_NAME, 1);

        req.onupgradeneeded = (e) => {

            const db = e.target.result;

            if (!db.objectStoreNames.contains(LOCAL_NOVEL_STORE_NAME)) {

                db.createObjectStore(LOCAL_NOVEL_STORE_NAME, { keyPath: 'id' });

            }

        };

        req.onsuccess = (e) => resolve(e.target.result);

        req.onerror = (e) => {

            console.warn("IndexedDB 開啟失敗:", e.target.error);

            resolve(null);

        };

    });

}

async function saveLocalNovelToDB(novelData) {

    try {

        const db = await getLocalNovelDB();

        if (!db) {

            // 優雅降級：若 IndexedDB 不可用則嘗試使用記憶體或 localStorage

            try { localStorage.setItem('novel_cache_' + novelData.id, JSON.stringify(novelData)); } catch(e){}

            return;

        }

        return new Promise((resolve) => {

            const tx = db.transaction(LOCAL_NOVEL_STORE_NAME, 'readwrite');

            const store = tx.objectStore(LOCAL_NOVEL_STORE_NAME);

            store.put(novelData);

            tx.oncomplete = () => resolve(true);

            tx.onerror = () => resolve(false);

        });

    } catch (e) {

        console.warn("儲存本機小說失敗:", e);

    }

}

async function getLocalNovelFromDB(id) {

    try {

        const db = await getLocalNovelDB();

        if (!db) {

            try {

                const raw = localStorage.getItem('novel_cache_' + id);

                return raw ? JSON.parse(raw) : null;

            } catch(e) { return null; }

        }

        return new Promise((resolve) => {

            const tx = db.transaction(LOCAL_NOVEL_STORE_NAME, 'readonly');

            const store = tx.objectStore(LOCAL_NOVEL_STORE_NAME);

            const req = store.get(id);

            req.onsuccess = () => resolve(req.result || null);

            req.onerror = () => resolve(null);

        });

    } catch (e) {

        console.warn("讀取本機小說失敗:", e);

        return null;

    }

}

function loadLocalBookIntoReader(bookTitle, chapters, existingId = null) {

    const bookId = existingId || ('local_' + bookTitle.replace(/\s+/g, '_'));

    novelState.currentNovel = {

        id: bookId,

        title: bookTitle,

        author: '本機上傳',

        cover: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=400&q=80',

        intro: `本機上傳電子書《${bookTitle}》，共收錄 ${chapters.length} 個章節。`,

        isLocal: true

    };

    novelState.chapters = chapters;

    // 自動異步持久化至 IndexedDB

    saveLocalNovelToDB({

        id: bookId,

        title: bookTitle,

        chapters: chapters,

        isLocal: true,

        updatedAt: new Date().toISOString()

    });

    const countEl = document.getElementById("novelSelectedChapterCount");

    if (countEl) countEl.textContent = `共 ${chapters.length} 章`;

    loadLocalNovelChapter(0);

    showToast(`📖 已開卷《${bookTitle}》，共 ${chapters.length} 章！`, "bi-journal-check text-success");

}

// 載入本機特定章節

function loadLocalNovelChapter(idx) {

    if (!novelState.chapters || idx < 0 || idx >= novelState.chapters.length) return;

    const ch = novelState.chapters[idx];

    novelState.currentChapterIdx = idx;

    novelState.currentParagraphs = ch.paragraphs || [];

    const placeholder = document.getElementById("legadoPlaceholder");

    if (placeholder) placeholder.style.display = "none";

    const readingArea = document.getElementById("novelReadingArea");

    if (readingArea) readingArea.style.display = "block";

    const titleEl = document.getElementById("novelBookTitle");

    const badgeEl = document.getElementById("novelChapterBadge");

    const headingEl = document.getElementById("novelChapterHeading");

    const paragraphsEl = document.getElementById("novelChapterParagraphs");

    if (titleEl) titleEl.textContent = novelState.currentNovel.title;

    if (badgeEl) badgeEl.textContent = ch.title;

    if (headingEl) headingEl.textContent = ch.title;

    if (paragraphsEl) {

        paragraphsEl.innerHTML = (ch.paragraphs || []).map(p => `

            <p class="mb-4 text-justify" style="text-indent: 2em; line-height: 2.2;">${escapeHtml(p)}</p>

        `).join('');

        const savedColor = novelState.customTextColor || (function() {

            try { return localStorage.getItem('novel_text_color'); } catch (e) { return null; }

        })();

        if (savedColor && typeof window.setNovelCustomTextColor === 'function') {

            window.setNovelCustomTextColor(savedColor);

        }

    }

    const bodyWrapper = document.getElementById("novelBodyWrapper");

    if (bodyWrapper) bodyWrapper.scrollTop = 0;

    updateNovelNavButtons();

}

// 關閉閱讀器 Modal

window.closeNovelReader = function() {

    // 預留可做進度暫存

};

// 更新上一章/下一章按鈕狀態

function updateNovelNavButtons() {

    const headerPrev = document.getElementById("novelHeaderPrevBtn");

    const headerNext = document.getElementById("novelHeaderNextBtn");

    const bottomPrev = document.getElementById("novelBottomPrevBtn");

    const bottomNext = document.getElementById("novelBottomNextBtn");

    const hasPrev = novelState.currentChapterIdx > 0;

    const hasNext = novelState.currentNovel && novelState.currentChapterIdx >= 0 && novelState.currentChapterIdx < novelState.chapters.length - 1;

    if (headerPrev) headerPrev.disabled = !hasPrev;

    if (headerNext) headerNext.disabled = !hasNext;

    if (bottomPrev) bottomPrev.disabled = !hasPrev;

    if (bottomNext) bottomNext.disabled = !hasNext;

}

// 主題切換 (sepia, white, dark)

window.setNovelTheme = function(theme) {

    novelState.theme = theme;

    const container = document.getElementById("novelContentContainer");

    if (container) {

        const isCustom = container.classList.contains('novel-custom-color');

        container.className = `modal-content border-0 novel-theme-${theme}${isCustom ? ' novel-custom-color' : ''}`;

    }

    // 更新按鈕 active 樣式

    ['sepia', 'white', 'dark'].forEach(t => {

        const btn = document.getElementById(`novelTheme${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);

        if (btn) {

            if (t === theme) {

                btn.classList.add('active');

            } else {

                btn.classList.remove('active');

            }

        }

    });

    // 若使用者未自訂顏色，將調色盤同調至該主題的預設文字顏色

    if (!novelState.customTextColor) {

        const defaultColor = theme === 'sepia' ? '#2d241e' : (theme === 'white' ? '#1e293b' : '#e4e4e7');

        const picker = document.getElementById("novelCustomColorPicker");

        if (picker) picker.value = defaultColor;

    }

};

// 使用者自訂正文字體顏色即時套用與持久化

window.setNovelCustomTextColor = function(color) {

    if (!color) return;

    novelState.customTextColor = color;

    try {

        localStorage.setItem('novel_text_color', color);

    } catch (e) {}

    const container = document.getElementById("novelContentContainer");

    if (container) {

        container.style.setProperty('--novel-custom-text-color', color);

        container.classList.add('novel-custom-color');

    }

    const headingEl = document.getElementById("novelChapterHeading");

    const paragraphsEl = document.getElementById("novelChapterParagraphs");

    if (headingEl) headingEl.style.setProperty('color', color, 'important');

    if (paragraphsEl) {

        paragraphsEl.style.setProperty('color', color, 'important');

        paragraphsEl.querySelectorAll('p').forEach(p => p.style.setProperty('color', color, 'important'));

    }

    const picker = document.getElementById("novelCustomColorPicker");

    if (picker) picker.value = color;

};

// 重置自訂字色為主題預設

window.resetNovelCustomTextColor = function() {

    novelState.customTextColor = null;

    try {

        localStorage.removeItem('novel_text_color');

    } catch (e) {}

    const container = document.getElementById("novelContentContainer");

    if (container) {

        container.style.removeProperty('--novel-custom-text-color');

        container.classList.remove('novel-custom-color');

    }

    const headingEl = document.getElementById("novelChapterHeading");

    const paragraphsEl = document.getElementById("novelChapterParagraphs");

    if (headingEl) headingEl.style.removeProperty('color');

    if (paragraphsEl) {

        paragraphsEl.style.removeProperty('color');

        paragraphsEl.querySelectorAll('p').forEach(p => p.style.removeProperty('color'));

    }

    const theme = novelState.theme || 'sepia';

    const defaultColor = theme === 'sepia' ? '#2d241e' : (theme === 'white' ? '#1e293b' : '#e4e4e7');

    const picker = document.getElementById("novelCustomColorPicker");

    if (picker) picker.value = defaultColor;

    showToast("已重置為主題預設文字顏色", "bi-arrow-counterclockwise text-secondary");

};

// 字級大小調整

window.adjustNovelFontSize = function(delta) {

    novelState.fontSize = Math.min(28, Math.max(14, novelState.fontSize + delta));

    const articleBox = document.getElementById("novelArticleContent");

    if (articleBox) {

        articleBox.style.fontSize = novelState.fontSize + "px";

    }

};

// 外部由卡片或搜尋跳轉開啟小說 (相容 openLegadoReader)

window.openLegadoReader = function(arg = null) {

    if (typeof arg === 'string' && arg.trim()) {

        openNovelSearchModal(arg.trim());

        return;

    }

    

    // 如果當前已有小說正文，則直接打開閱讀器

    if (novelState.currentNovel && novelState.currentChapterIdx >= 0) {

        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("novelReaderModal"));

        modal.show();

        return;

    }

    // 否則開啟純淨待命閱讀器

    closeCurrentNovel();

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("novelReaderModal"));

    modal.show();

};

window.openLegadoWithTitle = function(title) {

    openNovelSearchModal(title);

};

// --- D. Bangumi 官方每日新番時刻表模組 ---

window.bangumiCalendarData = window.bangumiCalendarData || null;

let currentCalendarDay = 1;

window.openBangumiCalendar = async function() {

    const modalEl = document.getElementById("bangumiCalendarModal");

    if (!modalEl) return;

    const modal = new bootstrap.Modal(modalEl);

    modal.show();

    // 今天是星期幾 (0 = 週日 -> 7)

    const today = new Date().getDay() || 7;

    currentCalendarDay = today;

    // 若尚未載入過數據，則發送 API

    if (!window.bangumiCalendarData) {

        const loadingEl = document.getElementById("bgmCalLoading");

        if (loadingEl) loadingEl.classList.remove("d-none");

        const grid = document.getElementById("bangumiAnimeGrid");

        if (grid) grid.innerHTML = "";

        try {

            const res = await fetch("https://api.bgm.tv/calendar");

            if (!res.ok) throw new Error("HTTP " + res.status);

            window.bangumiCalendarData = await res.json();

        } catch (e) {

            console.error("載入 Bangumi Calendar 失敗:", e);

            showToast("連線 Bangumi API 失敗，請確認網路！", "bi-exclamation-triangle-fill text-danger");

        } finally {

            if (loadingEl) loadingEl.classList.add("d-none");

        }

    }

    // 啟動當天標籤與渲染

    const targetTab = document.querySelector(`#bangumiWeekdayTabs [data-day="${today}"]`);

    switchCalendarWeekday(today, targetTab);

};

window.switchCalendarWeekday = function(dayId, btn) {

    currentCalendarDay = dayId;

    document.querySelectorAll("#bangumiWeekdayTabs .nav-link").forEach(b => b.classList.remove("active", "bg-dark", "text-white"));

    if (btn) {

        btn.classList.add("active", "bg-dark", "text-white");

    } else {

        const found = document.querySelector(`#bangumiWeekdayTabs [data-day="${dayId}"]`);

        if (found) found.classList.add("active", "bg-dark", "text-white");

    }

    renderCalendarDayAnime(dayId);

};

function renderCalendarDayAnime(dayId) {

    const grid = document.getElementById("bangumiAnimeGrid");

    if (!grid) return;

    grid.innerHTML = "";

    const calData = window.bangumiCalendarData;

    if (!calData) {

        grid.innerHTML = `<div class="col-12 text-center text-muted py-4">暫無放送數據</div>`;

        return;

    }

    // Bangumi API 陣列中的 weekday.id 為 1~7

    const dayData = calData.find(d => d.weekday && d.weekday.id === Number(dayId));

    if (!dayData || !dayData.items || dayData.items.length === 0) {

        grid.innerHTML = `<div class="col-12 text-center text-muted py-4">本日暫無新番放送數據</div>`;

        return;

    }

    dayData.items.forEach(anime => {

        const col = document.createElement("div");

        col.className = "col-6 col-md-4 col-lg-3 col-xl-2";

        const title = anime.name_cn || anime.name;

        let cover = anime.images?.large || anime.images?.common || anime.images?.medium || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=700&q=80";

        // 修正 Mixed Content

        cover = cover.replace(/^http:\/\//i, "https://");

        const score = anime.rating && anime.rating.score ? `⭐ ${anime.rating.score.toFixed(1)}` : "新番評分中";

        const bgmUrl = anime.url ? anime.url.replace(/^http:\/\//i, "https://") : `https://bgm.tv/subject/${anime.id}`;

        col.innerHTML = `

            <div class="card bgm-anime-card shadow-sm">

                <div class="bgm-anime-cover-box" style="cursor: pointer;" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" onclick="openKazumiFromElement(this)">

                    <img src="${escapeHtml(cover)}" class="bgm-anime-cover-img" alt="${escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=700&q=80'">

                    <div class="bgm-rating-badge">${score}</div>

                </div>

                <div class="p-2 d-flex flex-column flex-grow-1">

                    <h6 class="small fw-bold text-truncate mb-2" title="${escapeHtml(title)}" style="cursor: pointer;" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" onclick="openKazumiFromElement(this)">${escapeHtml(title)}</h6>

                    <div class="mt-auto d-flex flex-column gap-1">

                        <button class="btn btn-outline-primary btn-xs w-100" data-title="${escapeHtml(title)}" data-url="${escapeHtml(bgmUrl)}" data-cover="${escapeHtml(cover)}" onclick="collectBangumiFromElement(this)">

                            <i class="bi bi-bookmark-plus"></i> 一鍵收藏

                        </button>

                        <button class="btn btn-outline-danger btn-xs w-100" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" onclick="openKazumiFromElement(this)">

                            <i class="bi bi-broadcast"></i> 播放來源與觀看

                        </button>

                    </div>

                </div>

            </div>

        `;

        grid.appendChild(col);

    });

}

// 將 Bangumi 新番直接存入個人圖書館

window.collectBangumiAnime = function(title, url, cover) {

    const newBookmark = {

        id: "bm_" + Date.now(),

        title: title,

        url: url,

        category: "anime",

        tags: ["本季新番", "Bangumi同步", "動畫"],

        cover: cover,

        desc: "由 Bangumi 官方每日新番時刻表一鍵同步收錄至個人圖書館，支援 Kazumi 全網多源高速播放。",

        pinned: false,

        clicks: 0,

        createdAt: new Date().toISOString()

    };

    state.bookmarks.unshift(newBookmark);

    saveToStorage();

    updateUI();

    showToast(`🎉 已成功收藏《${title}》至個人圖書館【動畫】分類！`, "bi-check-circle-fill text-success");

};

// ==========================================

// 8. Bangumi 帳號追番清單一鍵同步核心 (支援單向匯入與雙向衝突優先同步)

// ==========================================

window.triggerBangumiUserSync = async function(mode = 'import') {

    const usernameInput = document.getElementById("bgmUsernameInput");

    const syncTypeSelect = document.getElementById("bgmSyncType");

    const subjectTypeSelect = document.getElementById("bgmSubjectType");

    const alertBox = document.getElementById("bgmSyncResultAlert");

    const syncBtn = document.getElementById("startBgmSyncBtn");

    const importOnlyBtn = document.getElementById("startBgmImportOnlyBtn");

    const twoWayBtn = document.getElementById("startBgmTwoWaySyncBtn");

    const username = (usernameInput ? usernameInput.value : "").trim();

    const syncType = syncTypeSelect ? syncTypeSelect.value : "3";

    const subjectType = subjectTypeSelect ? subjectTypeSelect.value : "2";

    // 儲存 Bangumi Personal Access Token (若有填寫)

    const tokenInput = document.getElementById("bgmTokenInput");

    if (tokenInput && tokenInput.value.trim()) {

        window.setBangumiToken(tokenInput.value.trim());

    }

    const token = window.getBangumiToken ? window.getBangumiToken() : "";

    const priority = window.getBgmPriority ? window.getBgmPriority() : "bangumi";

    // 雙向同步必須持有有效 Token

    if (mode === 'two-way' && !token) {

        if (alertBox) {

            alertBox.className = "alert alert-warning py-2 small";

            alertBox.innerHTML = '<i class="bi bi-shield-exclamation"></i> <strong>雙向全量同步需要授權令牌！</strong> 請先在上方貼上 Bangumi Access Token 並點擊「驗證令牌」後再試。若無需回寫 Bangumi，請點擊「僅從 Bangumi 匯入網頁」。';

            alertBox.classList.remove("d-none");

        }

        if (typeof showToast === "function") showToast("雙向同步需填寫 Bangumi Token", "bi-key-fill text-warning");

        return;

    }

    if (!username) {

        if (alertBox) {

            alertBox.className = "alert alert-warning py-2 small";

            alertBox.textContent = "請輸入 Bangumi 使用者名稱或數字 UID！";

            alertBox.classList.remove("d-none");

        }

        return;

    }

    const typeNames = { "1": "想看/想讀", "2": "看過/讀過", "3": "在看/在讀" };

    const currentTypeName = typeNames[syncType] || "在看/在讀";

    // 進入載入狀態與 UI 提示

    const isTwoWay = mode === 'two-way';

    if (syncBtn) {

        syncBtn.disabled = true;

        syncBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span> 連線中...`;

    }

    if (importOnlyBtn) {

        importOnlyBtn.disabled = true;

        if (!isTwoWay) importOnlyBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> 匯入中...`;

    }

    if (twoWayBtn) {

        twoWayBtn.disabled = true;

        if (isTwoWay) twoWayBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> 雙向比對回寫中...`;

    }

    if (alertBox) {

        alertBox.className = "alert alert-info py-2 small";

        alertBox.innerHTML = `<div class="d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm text-primary"></div><span>正在${isTwoWay ? '進行雙向同步比對' : '自 Bangumi 取得'}【${escapeHtml(username)}】的「${currentTypeName}」數據...</span></div>`;

        alertBox.classList.remove("d-none");

    }

    try {

        const typesToFetch = subjectType === "all" ? [2, 1] : [parseInt(subjectType, 10)];

        let allItems = [];

        for (const sType of typesToFetch) {

            const apiUrl = `https://api.bgm.tv/v0/users/${encodeURIComponent(username)}/collections?subject_type=${sType}&type=${syncType}&limit=30`;

            try {

                const res = await fetch(apiUrl, {

                    headers: { "Accept": "application/json" }

                });

                if (res.ok) {

                    const data = await res.json();

                    if (Array.isArray(data.data)) {

                        allItems = allItems.concat(data.data.map(d => ({ ...d, requestedSubjectType: sType })));

                    }

                } else if (res.status === 404 && typesToFetch.length === 1) {

                    throw new Error(`找不到使用者【${username}】，請檢查使用者名稱或數字 UID 是否正確。`);

                }

            } catch (fetchErr) {

                if (typesToFetch.length === 1) throw fetchErr;

            }

        }

        if (allItems.length === 0) {

            if (alertBox) {

                alertBox.className = "alert alert-warning py-2 small";

                alertBox.textContent = `使用者【${username}】目前沒有符合條件的 Bangumi 記錄。`;

            }

            return;

        }

        let addedCount = 0;

        let updatedCount = 0;

        let pushedCount = 0;

        for (const item of allItems) {

            const subject = item.subject || {};

            const subjectId = item.subject_id || subject.id;

            const isBook = item.requestedSubjectType === 1 || subject.type === 1;

            const title = subject.name_cn || subject.name || `Bangumi 作品 #${subjectId}`;

            const bgmUrl = `https://bgm.tv/subject/${subjectId}`;

            let cover = subject.images?.large || subject.images?.common || subject.images?.medium || subject.images?.small || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1000&q=80";

            cover = cover.replace(/^http:\/\//i, "https://");

            let currentEp = item.ep_status || 0;

            const totalEps = subject.eps || subject.total_episodes || "?";

            const scoreStr = subject.score ? `⭐ 評分 ${subject.score}` : "";

            const statusNum = parseInt(syncType, 10) || 3;

            const specificStatusLabel = isBook

                ? (statusNum === 1 ? '想讀' : statusNum === 2 ? '已讀過' : '已在讀')

                : (statusNum === 1 ? '想看' : statusNum === 2 ? '已看過' : '已在看');

            const category = isBook ? "resource" : "anime";

            const tags = ["Bangumi同步", specificStatusLabel, currentTypeName];

            if (isBook) tags.push("書籍", "漫畫", "小說");

            else tags.push("動畫");

            // 檢查圖書館中是否已存在

            const existingIdx = state.bookmarks.findIndex(b => b.url === bgmUrl || (b.title === title && (b.category === category || b.category === "anime" || b.category === "resource")));

            if (existingIdx !== -1) {

                const existing = state.bookmarks[existingIdx];

                // 雙向全量同步且以「網頁優先」：比對本地是否有更進一步的集數觀看記錄

                if (isTwoWay && priority === 'local' && token) {

                    let localEp = 0;

                    const epMatch = (existing.desc || '').match(/\[(\d+)\//);

                    if (epMatch) localEp = parseInt(epMatch[1], 10) || 0;

                    if (localEp > currentEp) {

                        try {

                            await fetch('/api/bangumi/episodes', {

                                method: 'POST',

                                headers: { 'Content-Type': 'application/json' },

                                body: JSON.stringify({ token, subjectId, watchedEpisodes: localEp })

                            });

                            pushedCount++;

                            currentEp = localEp; // 本地優先

                        } catch (pushErr) {

                            console.warn("回寫 Bangumi 集數失敗:", pushErr);

                        }

                    }

                }

                const desc = isBook

                    ? `Bangumi 書籍進度：[${currentEp}/${totalEps} 卷/話] ${scoreStr} · ${subject.short_summary || ""}`.trim()

                    : `Bangumi 追番進度：[${currentEp}/${totalEps} 集] ${scoreStr} · ${subject.short_summary || ""}`.trim();

                existing.cover = cover;

                existing.desc = desc;

                existing.category = category;

                existing.bangumiStatus = statusNum;

                existing.bangumiSubjectId = subjectId;

                if (!Array.isArray(existing.tags)) existing.tags = [];

                // 清理舊的狀態標籤並加入最新的精確標籤

                existing.tags = existing.tags.filter(t => !['想看', '在看', '看過', '已看', '已看過', '已在看', '想讀', '在讀', '讀過', '已讀', '已讀過', '已在讀', '在看/在讀', '看過/讀過', '想看/想讀'].includes(t));

                tags.forEach(t => {

                    if (!existing.tags.includes(t)) existing.tags.push(t);

                });

                updatedCount++;

            } else {

                const desc = isBook

                    ? `Bangumi 書籍進度：[${currentEp}/${totalEps} 卷/話] ${scoreStr} · ${subject.short_summary || ""}`.trim()

                    : `Bangumi 追番進度：[${currentEp}/${totalEps} 集] ${scoreStr} · ${subject.short_summary || ""}`.trim();

                const newBookmark = {

                    id: "bm_bgm_" + subjectId + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000),

                    title: title,

                    url: bgmUrl,

                    category: category,

                    tags: tags,

                    cover: cover,

                    desc: desc,

                    bangumiStatus: statusNum,

                    bangumiSubjectId: subjectId,

                    pinned: false,

                    clicks: 0,

                    createdAt: new Date().toISOString()

                };

                state.bookmarks.unshift(newBookmark);

                addedCount++;

            }

        }

        saveToStorage();

        updateUI();

        const priorityLabel = priority === 'bangumi' ? 'Bangumi 雲端' : '本網頁 本地';

        if (alertBox) {

            alertBox.className = "alert alert-success py-2 small";

            if (isTwoWay) {

                alertBox.innerHTML = `🎉 <b>雙向同步完成！</b> 新增 <b>${addedCount}</b> 部、更新 <b>${updatedCount}</b> 部，回寫 <b>${pushedCount}</b> 部至 Bangumi（衝突優先權：<b>${priorityLabel}</b>）。`;

            } else {

                alertBox.innerHTML = `🎉 <b>匯入完成！</b> 已成功將 <b>${addedCount}</b> 部新作品加入圖書館，更新 <b>${updatedCount}</b> 部「${currentTypeName}」作品。`;

            }

        }

        const toastMsg = isTwoWay

            ? `🎉 雙向全量同步成功！(新增 ${addedCount} / 更新 ${updatedCount} / 回寫 ${pushedCount})`

            : `🎉 成功自 Bangumi 匯入 ${addedCount + updatedCount} 部作品！`;

        if (typeof showToast === "function") showToast(toastMsg, "bi-check-circle-fill text-success");

        // 1.8 秒後自動關閉 Modal

        setTimeout(() => {

            const modalEl = document.getElementById("bangumiSyncModal");

            if (modalEl) {

                const modal = bootstrap.Modal.getInstance(modalEl);

                if (modal) modal.hide();

            }

            if (alertBox) alertBox.classList.add("d-none");

        }, 1800);

    } catch (err) {

        console.error("Bangumi 同步失敗", err);

        if (alertBox) {

            alertBox.className = "alert alert-danger py-2 small";

            alertBox.textContent = `❌ 同步失敗：${err.message || "網路連線異常，請稍後重試"}`;

        }

    } finally {

        if (syncBtn) {

            syncBtn.disabled = false;

            syncBtn.innerHTML = `<i class="bi bi-cloud-arrow-down-fill"></i> 開始同步匯入`;

        }

        if (importOnlyBtn) {

            importOnlyBtn.disabled = false;

            importOnlyBtn.innerHTML = `<i class="bi bi-cloud-arrow-down"></i> 僅從 Bangumi 匯入網頁`;

        }

        if (twoWayBtn) {

            twoWayBtn.disabled = false;

            twoWayBtn.innerHTML = `<i class="bi bi-arrow-repeat"></i> 雙向全量同步`;

        }

    }

};

// ==========================================

// 9. 批量管理 (Batch Management) 核心邏輯

// ==========================================

window.toggleBatchMode = function(forceState) {

    state.isBatchMode = (forceState !== undefined) ? forceState : !state.isBatchMode;

    if (!state.isBatchMode) {

        state.selectedBookmarkIds.clear();

    }

    updateBatchUI();

    renderBookmarks();

    if (state.isBatchMode) {

        showToast("已進入批量管理模式，點擊卡片即可勾選項目！", "bi-check2-square text-primary");

    }

};

window.updateBatchUI = function() {

    const bar = document.getElementById("batchActionBar");

    const btn = document.getElementById("batchModeBtn");

    const btnText = document.getElementById("batchBtnText");

    const countBadge = document.getElementById("batchCountBadge");

    if (state.isBatchMode) {

        if (bar) bar.classList.remove("d-none");

        if (btn) {

            btn.className = "btn btn-sm btn-primary rounded-pill d-flex align-items-center gap-1 px-3 shadow-sm";

        }

        if (btnText) btnText.textContent = "退出批量";

        if (countBadge) countBadge.textContent = state.selectedBookmarkIds.size;

    } else {

        if (bar) bar.classList.add("d-none");

        if (btn) {

            btn.className = "btn btn-sm btn-outline-primary rounded-pill d-flex align-items-center gap-1 px-3";

        }

        if (btnText) btnText.textContent = "批量管理";

    }

};

window.toggleSelectBookmark = function(id, explicitChecked) {

    if (!state.isBatchMode) return;

    if (explicitChecked !== undefined) {

        if (explicitChecked) state.selectedBookmarkIds.add(id);

        else state.selectedBookmarkIds.delete(id);

    } else {

        if (state.selectedBookmarkIds.has(id)) {

            state.selectedBookmarkIds.delete(id);

        } else {

            state.selectedBookmarkIds.add(id);

        }

    }

    updateBatchUI();

    renderBookmarks();

};

window.batchSelectAll = function(selectAll = true) {

    const currentItems = getFilteredAndSortedBookmarks();

    if (selectAll) {

        currentItems.forEach(b => state.selectedBookmarkIds.add(b.id));

    } else {

        state.selectedBookmarkIds.clear();

    }

    updateBatchUI();

    renderBookmarks();

};

window.batchChangeCategory = function(newCategory) {

    if (state.selectedBookmarkIds.size === 0) {

        showToast("請先勾選欲修改的書籤項目！", "bi-exclamation-circle text-warning");

        return;

    }

    const catNames = { anime: "動畫 (Kazumi)", web: "一般網頁", video: "影片影音", resource: "動漫資源" };

    let count = 0;

    state.bookmarks.forEach(b => {

        if (state.selectedBookmarkIds.has(b.id)) {

            b.category = newCategory;

            count++;

        }

    });

    saveToStorage();

    updateUI();

    updateBatchUI();

    showToast(`🎉 成功將 ${count} 個項目變更為「${catNames[newCategory] || newCategory}」！`, "bi-check-circle-fill text-success");

};

window.openBatchTagsModal = function() {

    if (state.selectedBookmarkIds.size === 0) {

        showToast("請先勾選欲新增標籤的書籤！", "bi-exclamation-circle text-warning");

        return;

    }

    const countSpan = document.getElementById("batchTagCountText");

    if (countSpan) countSpan.textContent = state.selectedBookmarkIds.size;

    const input = document.getElementById("batchNewTagInput");

    if (input) input.value = "";

    const modalEl = document.getElementById("batchTagsModal");

    if (modalEl) {

        const modal = new bootstrap.Modal(modalEl);

        modal.show();

    }

};

window.applyBatchTags = function() {

    const input = document.getElementById("batchNewTagInput");

    const rawVal = input ? input.value.trim() : "";

    if (!rawVal) {

        showToast("請輸入要新增的標籤名稱！", "bi-exclamation-circle text-warning");

        return;

    }

    const tagsToAdd = rawVal.split(/[,，\s]+/).filter(t => t.trim() !== "");

    if (tagsToAdd.length === 0) return;

    let count = 0;

    state.bookmarks.forEach(b => {

        if (state.selectedBookmarkIds.has(b.id)) {

            if (!Array.isArray(b.tags)) b.tags = [];

            tagsToAdd.forEach(t => {

                if (!b.tags.includes(t)) b.tags.push(t);

            });

            count++;

        }

    });

    saveToStorage();

    updateUI();

    updateBatchUI();

    const modalEl = document.getElementById("batchTagsModal");

    if (modalEl) {

        const modal = bootstrap.Modal.getInstance(modalEl);

        if (modal) modal.hide();

    }

    showToast(`🏷️ 成功為 ${count} 個書籤追加標籤：${tagsToAdd.join(", ")}！`, "bi-tags-fill text-success");

};

window.batchTogglePin = function() {

    if (state.selectedBookmarkIds.size === 0) {

        showToast("請先勾選項目！", "bi-exclamation-circle text-warning");

        return;

    }

    let count = 0;

    state.bookmarks.forEach(b => {

        if (state.selectedBookmarkIds.has(b.id)) {

            b.pinned = !b.pinned;

            count++;

        }

    });

    saveToStorage();

    updateUI();

    updateBatchUI();

    showToast(`📌 已批量切換 ${count} 個項目的置頂狀態！`, "bi-pin-angle-fill text-primary");

};

window.batchDeleteBookmarks = function() {

    const count = state.selectedBookmarkIds.size;

    if (count === 0) {

        showToast("請先勾選欲刪除的書籤！", "bi-exclamation-circle text-warning");

        return;

    }

    if (!confirm(`⚠️ 確定要批量刪除選取的 ${count} 個書籤收藏嗎？此操作無法還原！`)) {

        return;

    }

    _isLocalMutationActive = true;

    state.bookmarks = state.bookmarks.filter(b => !state.selectedBookmarkIds.has(b.id));

    state.selectedBookmarkIds.clear();

    saveToStorage(true); // 立即同步至伺服器

    updateUI();

    updateBatchUI();

    showToast(`🗑️ 已成功批量刪除 ${count} 個書籤！`, "bi-trash3-fill text-danger");

    // 設定 1.5 秒冷卻，避免 confirm 彈窗關閉觸發 window.focus 時誤將已被刪除的書籤重新合併

    setTimeout(() => {

        _isLocalMutationActive = false;

    }, 1500);

};

// HTML 特殊字元跳脫 (XSS 防護)

function escapeHtml(str) {

    if (!str) return "";

    return String(str)

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;")

        .replace(/"/g, "&quot;")

        .replace(/'/g, "&#039;");

}

// ==========================================

// 8. KazumiRules 前端即時搜尋與播放

// ==========================================

window.searchKazumiAnime = async function(keyword = null) {

    const input = document.getElementById("kazumiSearchInput");

    const q = (keyword !== null ? keyword : (input ? input.value : "")).trim();

    if (!q) {

        showToast("請輸入欲搜尋的動漫片名！", "bi-exclamation-circle text-warning");

        return;

    }

    if (input) input.value = q;

    const sourceSelect = document.getElementById("kazumiSourceSelect");

    const source = sourceSelect ? sourceSelect.value : "AGE";

    const loading = document.getElementById("kazumiSearchLoading");

    const grid = document.getElementById("kazumiResultsGrid");

    if (!grid) return;

    if (loading) loading.classList.remove("d-none");

    grid.innerHTML = "";

    try {

        const res = await fetch(`/api/kazumi/rule-search?q=${encodeURIComponent(q)}&source=${source}`);

        const data = await res.json();

        if (loading) loading.classList.add("d-none");

        if (data.success && Array.isArray(data.results) && data.results.length > 0) {

            data.results.forEach(item => {

                const col = document.createElement("div");

                col.className = "col";

                const cover = item.cover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=600&q=80";

                col.innerHTML = `

                    <div class="card bgm-anime-card shadow-sm h-100">

                        <div class="bgm-anime-cover-box">

                            <img src="${escapeHtml(cover)}" class="bgm-anime-cover-img" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=600&q=80'">

                            <div class="bgm-rating-badge bg-danger text-white border-0">${data.source} 源</div>

                        </div>

                        <div class="p-2 d-flex flex-column flex-grow-1">

                            <h6 class="small fw-bold text-truncate mb-2" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h6>

                            <div class="mt-auto">

                                <button class="btn btn-danger btn-xs w-100 d-flex align-items-center justify-content-center gap-1" data-title="${escapeHtml(item.title)}" data-url="${escapeHtml(item.detailUrl)}" data-source="${escapeHtml(data.source)}" onclick="watchKazumiFromElement(this)">

                                    <i class="bi bi-play-circle-fill"></i> 在線觀看全集

                                </button>

                            </div>

                        </div>

                    </div>

                `;

                grid.appendChild(col);

            });

            showToast(`已透過 ${data.source} 規則搜獲 ${data.results.length} 部「${q}」系列番劇！`, "bi-check-circle-fill text-success");

        } else {

            grid.innerHTML = `

                <div class="col-12 text-center py-4 text-muted">

                    <i class="bi bi-search fs-3 d-block mb-2"></i>

                    <span>未搜到「${escapeHtml(q)}」相關番劇，可嘗試切換備用規則源。</span>

                </div>

            `;

        }

    } catch (e) {

        if (loading) loading.classList.add("d-none");

        grid.innerHTML = `<div class="col-12 text-danger text-center py-3">搜尋失敗：${e.message}</div>`;

    }

};

window.quickKazumiSearch = function(keyword) {

    searchKazumiAnime(keyword);

};

// 點擊「在線觀看全集」

window.watchKazumiAnime = async function(title, detailUrl, source = "AGE") {

    showToast(`正在解析《${title}》選集清單...`, "bi-hourglass-split text-info");

    

    // 1. 打開 Modal

    document.getElementById("animePlayerTitle").textContent = `【Kazumi 在線】${title}`;

    const video = document.getElementById("kazumiVideoPlayer");

    const iframe = document.getElementById("kazumiIframePlayer");

    const iframeWrapper = document.getElementById("kazumiIframeWrapper");

    video.pause();

    video.controls = false;

    video.removeAttribute("controls");

    video.style.display = "none";

    if (iframeWrapper) iframeWrapper.style.display = "block";

    iframe.style.display = "block";

    iframe.src = "";

    const modal = new bootstrap.Modal(document.getElementById("animePlayerModal"));

    modal.show();

    setTimeout(() => {

        if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

    }, 100);

    // 2. 請求後端解析劇集

    try {

        const epRes = await fetch(`/api/kazumi/rule-episodes?detailUrl=${encodeURIComponent(detailUrl)}&source=${source}`);

        const epData = await epRes.json();

        

        if (epData.success && Array.isArray(epData.episodes) && epData.episodes.length > 0) {

            renderKazumiRuleEpisodes(title, epData.episodes, source);

            // 自動開播第 1 集

            playKazumiRuleEpisode(epData.episodes[0].playUrl, epData.episodes[0].title, source);

        } else {

            showToast("此動畫暫無可用選集或被站方隱藏", "bi-exclamation-triangle text-warning");

        }

    } catch (e) {

        showToast("解析劇集失敗：" + e.message, "bi-x-circle text-danger");

    }

};

function renderKazumiRuleEpisodes(animeTitle, episodes, source) {

    window.currentKazumiAnimeTitle = animeTitle;

    const modalTitle = document.getElementById("animePlayerTitle");

    if (modalTitle && episodes.length > 0) modalTitle.textContent = `${animeTitle} - ${episodes[0].title}`;

    const container = document.querySelector(".episode-list-container");

    if (!container) return;

    container.innerHTML = "";

    episodes.forEach((ep, idx) => {

        const btn = document.createElement("button");

        btn.className = `btn btn-sm ${idx === 0 ? 'btn-primary active' : 'btn-outline-secondary'} ep-btn text-truncate text-start`;

        btn.style.maxWidth = "100%";

        btn.title = ep.title;

        btn.innerHTML = `<i class="bi bi-play-fill"></i> ${escapeHtml(ep.title)}`;

        btn.onclick = () => {

            document.querySelectorAll(".ep-btn").forEach(b => {

                b.classList.remove("btn-primary", "active");

                b.classList.add("btn-outline-secondary");

            });

            btn.classList.remove("btn-outline-secondary");

            btn.classList.add("btn-primary", "active");

            if (modalTitle) modalTitle.textContent = `${animeTitle} - ${ep.title}`;

            playKazumiRuleEpisode(ep.playUrl, ep.title, source);

        };

        container.appendChild(btn);

    });

}

async function playKazumiRuleEpisode(playUrl, epTitle, source) {

    showToast(`正在載入 ${epTitle}...`, "bi-play-circle-fill text-danger");

    try {

        const res = await fetch(`/api/kazumi/rule-play?playUrl=${encodeURIComponent(playUrl)}&source=${source}`);

        const data = await res.json();

        if (data.success && data.playerUrl) {

            window.currentKazumiPlayingUrl = data.playerUrl;

            

            // 檢查是否為直接串流 (.mp4, .m3u8, 或後端標記 isDirectStream)

            const isDirect = data.isDirectStream || /\.(mp4|m3u8)(\?.*)?$/i.test(data.playerUrl);

            const video = document.getElementById("kazumiVideoPlayer");

            const iframe = document.getElementById("kazumiIframePlayer");

            const iframeWrapper = document.getElementById("kazumiIframeWrapper");

            const fallbackCard = document.getElementById("kazumiBlockedFallback");

            if (fallbackCard) fallbackCard.style.display = "none";

            if (isDirect) {

                // 原生播放器模式：支援原生音量調控、全螢幕面板無縫互動

                if (iframeWrapper) iframeWrapper.style.display = "none";

                if (iframe) { iframe.src = ""; iframe.style.display = "none"; }

                if (video) {

                    video.style.display = "block";

                    video.controls = false;

                    video.removeAttribute("controls");

                    

                    if (data.playerUrl.includes('.m3u8')) {

                        if (window.Hls && Hls.isSupported()) {

                            if (window.kazumiHlsInstance) {

                                window.kazumiHlsInstance.destroy();

                                window.kazumiHlsInstance = null;

                            }

                            const hls = new Hls({ enableWorker: true });

                            hls.loadSource(data.playerUrl);

                            hls.attachMedia(video);

                            window.kazumiHlsInstance = hls;

                            hls.on(Hls.Events.MANIFEST_PARSED, () => {

                                video.play().catch(() => {});

                            });

                        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {

                            if (window.kazumiHlsInstance) {

                                window.kazumiHlsInstance.destroy();

                                window.kazumiHlsInstance = null;

                            }

                            video.src = data.playerUrl;

                            video.currentTime = 0;

                            video.play().catch(() => {});

                        } else {

                            video.src = data.playerUrl;

                            video.currentTime = 0;

                            video.play().catch(() => {});

                        }

                    } else {

                        if (window.kazumiHlsInstance) {

                            window.kazumiHlsInstance.destroy();

                            window.kazumiHlsInstance = null;

                        }

                        video.src = data.playerUrl;

                        video.currentTime = 0;

                        video.play().catch(() => {});

                    }

                }

                showToast(`已載入 ${epTitle}，原生高畫質串流開播！`, "bi-check-circle-fill text-success");

            } else {

                // iframe 模式

                if (window.kazumiHlsInstance) {

                    window.kazumiHlsInstance.destroy();

                    window.kazumiHlsInstance = null;

                }

                if (video) { video.pause(); video.style.display = "none"; }

                if (iframeWrapper) {

                    iframeWrapper.style.display = "block";

                    if (data.playerUrl && data.playerUrl.includes('bilibili')) {

                        iframeWrapper.classList.add("is-bilibili");

                        iframeWrapper.classList.remove("is-pure-anime");

                    } else if (data.playerUrl && !data.playerUrl.includes('youtube')) {

                        iframeWrapper.classList.remove("is-bilibili");

                        iframeWrapper.classList.add("is-pure-anime");

                    } else {

                        iframeWrapper.classList.remove("is-bilibili");

                        iframeWrapper.classList.remove("is-pure-anime");

                    }

                }

                if (iframe) {

                    iframe.style.display = "block";

                    iframe.src = data.playerUrl;

                }

                showToast(`已載入 ${epTitle}，即刻開播！`, "bi-check-circle-fill text-success");

                if (data.playerUrl.includes('lmm85.com') && !data.playerUrl.includes('dp.no3acg.com')) {

                    showToast("💡 此集來源因站方安全保護無法內嵌，請點擊【新分頁播放】即可開播！", "bi-info-circle-fill text-warning");

                }

            }

            setTimeout(() => {

                if (typeof window.applyKazumiVolume === 'function') window.applyKazumiVolume(false);

            }, 100);

            // 啟動彈幕流

            const epMatch = (epTitle || '').match(/\d+/);

            const epNo = epMatch ? parseInt(epMatch[0], 10) : 1;

            const cleanAnime = (window.currentKazumiAnimeTitle || '').split('-')[0].trim() || '動漫';

            startDanmakuStream(cleanAnime, null, epNo);

        } else {

            showToast("此集暫無播放器資源", "bi-exclamation-triangle text-warning");

        }

    } catch (e) {

        showToast("載入播放器失敗", "bi-x-circle text-danger");

    }

}

// 另開新分頁播放 (完美解決第三方播放器 X-Frame-Options SAMEORIGIN / Cloudflare 防護阻擋內嵌問題)

window.openCurrentInNewTab = function() {

    const iframe = document.getElementById("kazumiIframePlayer");

    const video = document.getElementById("kazumiVideoPlayer");

    const url = window.currentKazumiPlayingUrl || (iframe && iframe.src) || (video && video.src);

    if (!url || url === 'about:blank' || url.endsWith('/')) {

        showToast("目前尚無可播放的外部網址", "bi-exclamation-triangle text-warning");

        return;

    }

    window.open(url, '_blank', 'noopener,noreferrer');

    showToast("已在新分頁開啟播放頁面！", "bi-box-arrow-up-right text-info");

};

// 若在 ACG 頁面，綁定 Enter 鍵快速搜尋 (保持初始乾淨空白待命)

document.addEventListener("DOMContentLoaded", () => {

    const searchInput = document.getElementById("kazumiSearchInput");

    if (searchInput) {

        searchInput.addEventListener("keydown", (e) => {

            if (e.key === "Enter") searchKazumiAnime();

        });

    }

});

// 自動預填 Bangumi 個人令牌與帳號以及衝突優先權

document.addEventListener("DOMContentLoaded", () => {

    const bgmModal = document.getElementById("bangumiSyncModal");

    if (bgmModal) {

        bgmModal.addEventListener("show.bs.modal", () => {

            const tokenInput = document.getElementById("bgmTokenInput");

            if (tokenInput) {

                tokenInput.value = window.getBangumiToken ? window.getBangumiToken() : "";

            }

            const priority = window.getBgmPriority ? window.getBgmPriority() : "bangumi";

            const priorityBangumiRadio = document.getElementById("priorityBangumi");

            const priorityLocalRadio = document.getElementById("priorityLocal");

            if (priority === "local" && priorityLocalRadio) {

                priorityLocalRadio.checked = true;

            } else if (priorityBangumiRadio) {

                priorityBangumiRadio.checked = true;

            }

            const statusBox = document.getElementById("bgmTokenStatus");

            if (statusBox) statusBox.classList.add("d-none");

            const alertBox = document.getElementById("bgmSyncResultAlert");

            if (alertBox) alertBox.classList.add("d-none");

        });

    }

});

// 初始化小說閱讀器自訂字體顏色與書源狀態

document.addEventListener("DOMContentLoaded", () => {

    try {

        loadDanmakuSettings();

        applyDanmakuConfigToCSS();

        updateNovelSourcePills();

        const novelSourceSelect = document.getElementById("novelSourceSelect");

        if (novelSourceSelect) {

            novelSourceSelect.value = currentNovelSource;

        }

    } catch (e) {}

    try {

        const savedColor = localStorage.getItem('novel_text_color');

        if (savedColor) {

            novelState.customTextColor = savedColor;

            const picker = document.getElementById("novelCustomColorPicker");

            if (picker) picker.value = savedColor;

            const container = document.getElementById("novelContentContainer");

            if (container) {

                container.style.setProperty('--novel-custom-text-color', savedColor);

                container.classList.add('novel-custom-color');

            }

        }

    } catch (e) {}

});

// ==========================================

// C. 歷史紀錄、Bangumi 狀態辨識/同步與書籤匯入

// ==========================================

function isMangaItem(item) {

    if (!item) return false;

    return (item.category === 'manga' || item.category === 'resource') || 

           (Array.isArray(item.tags) && item.tags.some(t => t.includes('漫畫') || t.includes('条漫') || t.includes('Tachimanga')));

}

window.getBookmarkWatchStatusLabel = function(item) {

    if (!item) return '狀態';

    const isManga = isMangaItem(item);

    // 1. 優先檢查 bangumiStatus 數值 (3: 已在看/已在讀, 2: 已看過/已讀過, 1: 想看/想讀)

    if (item.bangumiStatus !== undefined && item.bangumiStatus !== null) {

        const s = parseInt(item.bangumiStatus, 10);

        if (s === 3) return isManga ? '已在讀' : '已在看';

        if (s === 2) return isManga ? '已讀過' : '已看過';

        if (s === 1) return isManga ? '想讀' : '想看';

    }

    // 2. 檢查 tags 標籤陣列 (支援模糊匹配、複合標籤如「在看/在讀」、「#在看/在讀」、「#已看」等)

    if (Array.isArray(item.tags)) {

        if (item.tags.some(t => typeof t === 'string' && (t.includes('在看') || t.includes('在讀')))) {

            return isManga ? '已在讀' : '已在看';

        }

        if (item.tags.some(t => typeof t === 'string' && (t.includes('看過') || t.includes('已看') || t.includes('讀過') || t.includes('已讀')))) {

            return isManga ? '已讀過' : '已看過';

        }

        if (item.tags.some(t => typeof t === 'string' && (t.includes('想看') || t.includes('想讀')))) {

            return isManga ? '想讀' : '想看';

        }

    }

    // 3. 檢查快取

    if (item.title) {

        const cleanTitle = cleanBangumiQueryTitle(item.title);

        const cached = (window.bangumiSubjectStatusCache && (window.bangumiSubjectStatusCache[cleanTitle] || window.bangumiSubjectStatusCache[item.title]));

        if (cached && cached.type > 0) {

            if (cached.type === 3) return isManga ? '已在讀' : '已在看';

            if (cached.type === 2) return isManga ? '已讀過' : '已看過';

            if (cached.type === 1) return isManga ? '想讀' : '想看';

        }

    }

    return '標記狀態';

};

window.updateCardWatchStatus = async function(bookmarkId, newType) {

    const item = state.bookmarks.find(b => b.id === bookmarkId);

    if (!item) return;

    const isManga = isMangaItem(item);

    const typeLabel = isManga 

        ? (newType === 1 ? '想讀' : newType === 2 ? '已讀過' : '已在讀')

        : (newType === 1 ? '想看' : newType === 2 ? '已看過' : '已在看');

    if (!Array.isArray(item.tags)) item.tags = [];

    item.tags = item.tags.filter(t => !['想看', '在看', '看過', '已看', '已看過', '已在看', '想讀', '在讀', '讀過', '已讀', '已讀過', '已在讀', '在看/在讀', '看過/讀過', '想看/想讀', '#在看/在讀', '#看過/讀過', '#想看/想讀'].includes(t));

    item.tags.push(typeLabel);

    item.bangumiStatus = newType;

    saveBookmarksLocally();

    renderBookmarks();

    showToast(`已將《${item.title}》標記為「${typeLabel}」`, "bi-bookmark-check-fill text-info");

    // 同步回寫 Bangumi

    const token = window.getBangumiToken ? window.getBangumiToken() : '';

    if (token) {

        let subjectId = null;

        if (item.url && /bgm\.tv\/subject\/(\d+)/.test(item.url)) {

            subjectId = item.url.match(/bgm\.tv\/subject\/(\d+)/)[1];

        } else if (item.bangumiSubjectId) {

            subjectId = item.bangumiSubjectId;

        } else {

            const statusInfo = await window.fetchBangumiSubjectStatus(item.title, isManga ? 1 : 2);

            if (statusInfo && statusInfo.subjectId) {

                subjectId = statusInfo.subjectId;

                item.bangumiSubjectId = subjectId;

                saveBookmarksLocally();

            }

        }

        if (subjectId) {

            await window.syncStatusToBangumi(subjectId, newType);

        } else {

            showToast("已更新本地標記（未找到對應 Bangumi 作品 ID）", "bi-info-circle text-muted");

        }

    } else {

        showToast("提示：綁定 Bangumi Token 可自動回寫官方收藏狀態！", "bi-key text-warning");

    }

    // 同步後端檔案庫

    const currentUser = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'default';

    try {

        await fetch('/api/bookmarks/sync', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ user: currentUser, bookmarks: state.bookmarks })

        });

    } catch(e) {}

};

// 搜尋結果加入圖書館

window.addAnimeSearchResultToLibrary = async function(title, cover, url) {

    if (!title) return;

    const currentUser = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'default';

    const newBookmark = {

        id: 'bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),

        title: title.trim(),

        url: url || `https://bgm.tv/subject_search/${encodeURIComponent(title)}?cat=2`,

        cover: cover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=700&q=80",

        category: "anime",

        tags: ["動畫", "動漫劇院", "Kazumi播放"],

        desc: `從動漫來源庫收藏之作品《${title.trim()}》`,

        pinned: false,

        clicks: 0,

        createdAt: new Date().toISOString()

    };

    const exists = state.bookmarks.some(b => b.title === newBookmark.title);

    if (exists) {

        showToast(`《${title}》已在您的圖書館收藏中！`, "bi-bookmark-check-fill text-warning");

        return;

    }

    state.bookmarks.unshift(newBookmark);

    saveBookmarksLocally();

    renderBookmarks();

    renderCategoryTabs();

    try {

        await fetch('/api/bookmarks/add', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ user: currentUser, bookmark: newBookmark })

        });

    } catch(e) {}

    showToast(`🎉 已成功將《${title}》收藏至個人圖書館！`, "bi-bookmark-plus-fill text-success");

};

window.addMangaSearchResultToLibrary = async function(title, cover, mangaId) {

    if (!title) return;

    const currentUser = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || 'default';

    const newBookmark = {

        id: 'bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),

        title: title.trim(),

        url: `https://www.webmota.com/comic/${encodeURIComponent(mangaId)}`,

        cover: cover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=300&q=80",

        category: "resource",

        tags: ["漫畫", "條漫", "Tachimanga"],

        desc: `從漫畫庫收藏之作品《${title.trim()}》`,

        pinned: false,

        clicks: 0,

        createdAt: new Date().toISOString()

    };

    const exists = state.bookmarks.some(b => b.title === newBookmark.title);

    if (exists) {

        showToast(`《${title}》已在您的圖書館收藏中！`, "bi-bookmark-check-fill text-warning");

        return;

    }

    state.bookmarks.unshift(newBookmark);

    saveBookmarksLocally();

    renderBookmarks();

    renderCategoryTabs();

    try {

        await fetch('/api/bookmarks/add', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ user: currentUser, bookmark: newBookmark })

        });

    } catch(e) {}

    showToast(`🎉 已成功將《${title}》收藏至個人圖書館！`, "bi-bookmark-plus-fill text-success");

};

// Bangumi 狀態辨識與快速修改快取

window.bangumiSubjectStatusCache = window.bangumiSubjectStatusCache || {};

function cleanBangumiQueryTitle(rawTitle) {

    if (!rawTitle) return '';

    let t = String(rawTitle).trim();

    // 移除常見的包裝括號與前綴後綴標記

    t = t.replace(/【.*?】|\[.*?\]|（.*?）|\(.*?\)|〔.*?〕|〈.*?〉|《.*?》|「.*?」|『.*?』/g, ' ');

    // 移除季數、話數、分P、畫質標記

    t = t.replace(/(第[0-9一二三四五六七八九十百]+[季期部話集]|Season\s*\d+|S\d+|Part\s*\d+|P\d+|TV(動畫|版)?|劇場版|特別篇|OVA|OAD|全\d+[集話]|\d+話全|\d+集全|1080[pP]|720[pP]|4[kK]|BDRip|BD)/gi, ' ');

    t = t.replace(/\s+/g, ' ').trim();

    return t;

}

window.fetchBangumiSubjectStatus = async function(title, typeId = 2) {

    const cleanTitle = cleanBangumiQueryTitle(title);

    if (!cleanTitle && !title) return null;

    const queryKey = cleanTitle || title.trim();

    if (window.bangumiSubjectStatusCache[queryKey]) {

        return window.bangumiSubjectStatusCache[queryKey];

    }

    if (window.bangumiSubjectStatusCache[title]) {

        return window.bangumiSubjectStatusCache[title];

    }

    const token = window.getBangumiToken ? window.getBangumiToken() : '';

    // 檢查本地現有書籤庫是否已綁定 subjectId 或具備狀態標籤

    let knownSubjectId = null;

    let localColType = 0;

    const existingBm = (state.bookmarks || []).find(b => {

        if (!b) return false;

        if (b.title === title || b.title === queryKey) return true;

        const bClean = cleanBangumiQueryTitle(b.title);

        return bClean && (bClean === queryKey || bClean === title);

    });

    if (existingBm) {

        if (existingBm.bangumiSubjectId) {

            knownSubjectId = existingBm.bangumiSubjectId;

        } else if (existingBm.url && /bgm\.tv\/subject\/(\d+)/.test(existingBm.url)) {

            knownSubjectId = existingBm.url.match(/bgm\.tv\/subject\/(\d+)/)[1];

        }

        if (existingBm.bangumiStatus) {

            localColType = parseInt(existingBm.bangumiStatus, 10) || 0;

        } else if (Array.isArray(existingBm.tags)) {

            if (existingBm.tags.some(t => typeof t === 'string' && (t.includes('在看') || t.includes('在讀')))) localColType = 3;

            else if (existingBm.tags.some(t => typeof t === 'string' && (t.includes('看過') || t.includes('已看') || t.includes('讀過') || t.includes('已讀')))) localColType = 2;

            else if (existingBm.tags.some(t => typeof t === 'string' && (t.includes('想看') || t.includes('想讀')))) localColType = 1;

        }

    }

    try {

        let subjectId = knownSubjectId;

        let subjectTitle = queryKey;

        // 若尚未知曉 subjectId，則向後端 Bangumi Search 檢索

        if (!subjectId) {

            const searchRes = await fetch(`/api/bangumi/search?q=${encodeURIComponent(queryKey)}&type=${typeId}${token ? `&token=${encodeURIComponent(token)}` : ''}`);

            const searchData = await searchRes.json();

            if (searchData.success && searchData.data && Array.isArray(searchData.data.data) && searchData.data.data.length > 0) {

                const candidates = searchData.data.data;

                const matchedSubject = candidates.find(s => 

                    (s.name_cn && (s.name_cn.trim() === queryKey || s.name_cn.trim() === title)) ||

                    (s.name && (s.name.trim() === queryKey || s.name.trim() === title))

                ) || candidates.find(s =>

                    (s.name_cn && (s.name_cn.includes(queryKey) || queryKey.includes(s.name_cn))) ||

                    (s.name && (s.name.includes(queryKey) || queryKey.includes(s.name)))

                ) || candidates[0];

                if (matchedSubject && matchedSubject.id) {

                    subjectId = matchedSubject.id;

                    subjectTitle = matchedSubject.name_cn || matchedSubject.name || queryKey;

                }

            }

        }

        if (subjectId) {

            let colType = 0; // 0 = 未收藏

            if (token) {

                const colRes = await fetch(`/api/bangumi/collection?subjectId=${subjectId}&token=${encodeURIComponent(token)}`);

                const colData = await colRes.json();

                if (colData.success && colData.data && typeof colData.data.type !== 'undefined') {

                    colType = parseInt(colData.data.type, 10) || 0;

                }

            }

            // 若 Bangumi 未查詢到或未收藏但本地書籤已有標記，優先回退本地標記

            if (colType === 0 && localColType > 0) {

                colType = localColType;

            }

            const resObj = { subjectId, type: colType, title: subjectTitle };

            window.bangumiSubjectStatusCache[queryKey] = resObj;

            window.bangumiSubjectStatusCache[title] = resObj;

            if (existingBm && !existingBm.bangumiSubjectId) {

                existingBm.bangumiSubjectId = subjectId;

                if (colType > 0 && !existingBm.bangumiStatus) {

                    existingBm.bangumiStatus = colType;

                }

            }

            return resObj;

        }

    } catch(e) {

        console.warn('查詢 Bangumi 狀態失敗:', e.message);

    }

    if (localColType > 0) {

        const fallbackObj = { subjectId: knownSubjectId, type: localColType, title: queryKey };

        window.bangumiSubjectStatusCache[queryKey] = fallbackObj;

        return fallbackObj;

    }

    return null;

};

window.checkAndRenderBangumiStatus = async function(title, typeId, elementId) {

    const el = document.getElementById(elementId);

    if (!el) return;

    const isManga = typeId === 1;

    const info = await window.fetchBangumiSubjectStatus(title, typeId);

    if (!info) {

        el.textContent = "未標記";

        el.className = "text-white-50";

        return;

    }

    const type = info.type;

    const mapLabels = isManga

        ? { 1: "想讀", 2: "已讀過", 3: "已在讀", 4: "擱置", 5: "拋棄" }

        : { 1: "想看", 2: "已看過", 3: "已在看", 4: "擱置", 5: "拋棄" };

    

    if (mapLabels[type]) {

        el.textContent = mapLabels[type];

        el.className = type === 3 ? "text-success fw-bold" : type === 2 ? "text-primary fw-bold" : "text-danger fw-bold";

    } else {

        el.textContent = "未收藏";

        el.className = "text-white-50";

    }

};

window.applyBangumiStatusChange = async function(title, statusType, isManga = false, elementId = null) {

    const info = await window.fetchBangumiSubjectStatus(title, isManga ? 1 : 2);

    if (!info || !info.subjectId) {

        showToast("未找到對應的 Bangumi 作品條目！", "bi-exclamation-triangle text-warning");

        return;

    }

    const token = window.getBangumiToken ? window.getBangumiToken() : '';

    if (!token) {

        showToast("請在個人設定「同步 Bangumi」中綁定 Access Token，即可啟用雙向回寫！", "bi-key text-warning");

        return;

    }

    const success = await window.syncStatusToBangumi(info.subjectId, statusType);

    if (success) {

        info.type = statusType;

        const cleanTitle = cleanBangumiQueryTitle(title);

        window.bangumiSubjectStatusCache[cleanTitle] = info;

        window.bangumiSubjectStatusCache[title] = info;

        // 同步更新本地書籤庫中匹配作品的狀態標記與卡片

        const typeLabel = isManga 

            ? (statusType === 1 ? '想讀' : statusType === 2 ? '已讀過' : '已在讀')

            : (statusType === 1 ? '想看' : statusType === 2 ? '已看過' : '已在看');

        let updatedAnyBookmark = false;

        (state.bookmarks || []).forEach(bm => {

            if (bm.title === title || bm.title === cleanTitle || bm.bangumiSubjectId === info.subjectId) {

                bm.bangumiSubjectId = info.subjectId;

                bm.bangumiStatus = statusType;

                if (!Array.isArray(bm.tags)) bm.tags = [];

                bm.tags = bm.tags.filter(t => !['想看', '在看', '看過', '已看', '已看過', '已在看', '想讀', '在讀', '讀過', '已讀', '已讀過', '已在讀', '在看/在讀', '看過/讀過', '想看/想讀', '#在看/在讀', '#看過/讀過', '#想看/想讀'].includes(t));

                bm.tags.push(typeLabel);

                updatedAnyBookmark = true;

            }

        });

        if (updatedAnyBookmark) {

            saveBookmarksLocally();

            renderBookmarks();

        }

        if (elementId) {

            const el = document.getElementById(elementId);

            if (el) {

                const mapLabels = isManga

                    ? { 1: "想讀", 2: "已讀過", 3: "已在讀" }

                    : { 1: "想看", 2: "已看過", 3: "已在看" };

                el.textContent = mapLabels[statusType] || "已收藏";

                el.className = statusType === 3 ? "text-success fw-bold" : statusType === 2 ? "text-primary fw-bold" : "text-danger fw-bold";

            }

        }

    }

};

// ==================== 全方位觀看歷史紀錄系統 (支援動漫/YouTube/Bilibili/直連串流) ====================

window.getWatchHistoryList = function() {

    try {

        let list = JSON.parse(localStorage.getItem('web_library_watch_history') || '[]');

        if (list.length === 0) {

            // 自動遷移舊版 web_library_anime_history 紀錄

            const oldAnime = JSON.parse(localStorage.getItem('web_library_anime_history') || '[]');

            if (oldAnime.length > 0) {

                list = oldAnime.map(a => ({

                    id: 'wh_' + (a.updatedAt || Date.now()) + '_' + Math.random().toString(36).substring(2, 6),

                    title: a.animeTitle,

                    epTitle: a.epTitle || '第 1 話',

                    playUrl: a.playUrl || '',

                    cover: a.cover || '',

                    platform: 'anime',

                    currentTime: a.currentTime || 0,

                    duration: a.duration || 0,

                    updatedAt: a.updatedAt || Date.now()

                }));

            }

        }

        // 舊資料自動清洗：如果封面含有明日香照片 (photo-1578632767115)，自動由書籤庫或中性海報替換；並將舊資料中之「視頻」替換為台灣用語「影片」

        let hasFixed = false;

        list.forEach(item => {

            if (!item.cover || item.cover.includes('photo-1578632767115')) {

                item.cover = window.getFallbackAnimeCover ? window.getFallbackAnimeCover(item.title, item.platform) : '';

                hasFixed = true;

            } else if (item.platform === 'youtube' && item.playUrl) {

                const ytMatch = item.playUrl.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

                if (ytMatch && (!item.cover || item.cover.startsWith('data:image/svg'))) {

                    item.cover = `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;

                    hasFixed = true;

                }

            }

            if (item.epTitle && item.epTitle.includes('視頻')) {

                item.epTitle = item.epTitle.replace(/視頻/g, '影片');

                hasFixed = true;

            }

            if (item.title && item.title.includes('視頻')) {

                item.title = item.title.replace(/視頻/g, '影片');

                hasFixed = true;

            }

        });

        // 自動清洗待命狀態髒資料與無播放來源項目

        const prevCount = list.length;

        list = list.filter(item => item && item.title && !item.title.includes('待命') && item.title !== '動漫劇院播放器' && item.playUrl && item.playUrl.trim() !== '');

        if (list.length !== prevCount) {

            hasFixed = true;

        }

        if (hasFixed) {

            localStorage.setItem('web_library_watch_history', JSON.stringify(list));

        }

        return list;

    } catch(e) {

        return [];

    }

};

// 切換動漫劇院「最近觀看紀錄」懸浮視窗 (Floating Panel)

window.toggleTheaterFloatingHistory = function(forceState) {

    const panel = document.getElementById("theaterFloatingHistoryPanel");

    if (!panel) return;

    const isShown = panel.style.display !== 'none';

    const nextState = (typeof forceState === 'boolean') ? forceState : !isShown;

    panel.style.display = nextState ? 'flex' : 'none';

    if (nextState) {

        panel.classList.add('flex-column');

        if (typeof window.renderAnimeHistoryStandby === 'function') {

            window.renderAnimeHistoryStandby();

        }

    }

};

// 點擊懸浮面板外部自動收合

document.addEventListener("click", (e) => {

    const panel = document.getElementById("theaterFloatingHistoryPanel");

    const btn = document.getElementById("theaterHistoryFloatingToggleBtn");

    if (!panel || panel.style.display === 'none') return;

    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;

    panel.style.display = 'none';

});

window.saveWatchHistory = function(title, cover, epTitle, playUrl, currentTime = 0, duration = 0, platform = '') {

    // 嚴格守衛：待命狀態、純空白片名或無播放網址時絕不寫入歷史紀錄

    if (!title || title.trim() === "" || title.includes("待命") || title.trim() === "動漫劇院播放器") return;

    if (!playUrl || playUrl.trim() === "") return;

    try {

        let history = window.getWatchHistoryList();

        const cleanTitle = title.trim();

        // 智能識別平台來源

        let detectedPlatform = platform;

        if (!detectedPlatform) {

            if (playUrl.includes('youtube') || playUrl.includes('youtu.be')) {

                detectedPlatform = 'youtube';

            } else if (playUrl.includes('bilibili')) {

                detectedPlatform = 'bilibili';

            } else {

                detectedPlatform = 'anime';

            }

        }

        // 封面智能補全（杜絕無關手辦圖，精準抓取官方封面/YouTube縮圖/中性SVG）

        let finalCover = cover;

        if (!finalCover || finalCover.includes('photo-1578632767115')) {

            if (detectedPlatform === 'youtube') {

                const ytMatch = playUrl.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

                if (ytMatch) finalCover = `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;

                else finalCover = window.getFallbackAnimeCover ? window.getFallbackAnimeCover(cleanTitle, 'youtube') : '';

            } else if (detectedPlatform === 'bilibili') {

                finalCover = (kazumiState && kazumiState.cover && !kazumiState.cover.includes('photo-1578632767115')) ? kazumiState.cover : (window.getFallbackAnimeCover ? window.getFallbackAnimeCover(cleanTitle, 'bilibili') : '');

            } else {

                finalCover = (kazumiState && kazumiState.cover && !kazumiState.cover.includes('photo-1578632767115')) ? kazumiState.cover : (window.getFallbackAnimeCover ? window.getFallbackAnimeCover(cleanTitle, 'anime') : '');

            }

        }

        // 移除同標題或同播放地址之舊紀錄 (去重)

        history = history.filter(h => h.title !== cleanTitle && h.playUrl !== playUrl);

        const newRecord = {

            id: 'wh_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),

            title: cleanTitle,

            cover: finalCover,

            epTitle: epTitle || (detectedPlatform === 'anime' ? '第 1 話' : '完整影片'),

            playUrl: playUrl || '',

            platform: detectedPlatform,

            currentTime: Math.floor(currentTime || 0),

            duration: Math.floor(duration || 0),

            updatedAt: Date.now()

        };

        history.unshift(newRecord);

        if (history.length > 30) history = history.slice(0, 30);

        localStorage.setItem('web_library_watch_history', JSON.stringify(history));

        // 觸發雙向 UI 渲染

        window.renderAnimeHistoryStandby();

        window.renderWatchHistoryGrid();

    } catch(e) {

        console.error('儲存觀看歷史失敗:', e);

    }

};

// 向下相容動畫劇院專用歷史調用

window.saveAnimePlayHistory = function(animeTitle, cover, epTitle, playUrl, currentTime = 0, duration = 0) {

    window.saveWatchHistory(animeTitle, cover, epTitle, playUrl, currentTime, duration, 'anime');

};

let lastAnimeThrottleTime = 0;

window.throttleSaveAnimeProgress = function(currentTime, duration) {

    const now = Date.now();

    if (now - lastAnimeThrottleTime > 4000) {

        lastAnimeThrottleTime = now;

        window.saveCurrentAnimeProgressNow();

    }

};

window.saveCurrentAnimeProgressNow = function() {

    const video = document.getElementById("kazumiVideoPlayer");

    const animeTitle = kazumiState.title || window.currentKazumiAnimeTitle || (document.getElementById("animePlayerTitle")?.textContent || '').split('-')[0]?.trim() || '';

    const epTitle = (document.getElementById("animePlayerTitle")?.textContent || '').split('-')[1]?.trim() || '';

    const playUrl = window.currentKazumiPlayingUrl || '';

    // 嚴格守衛：待命狀態或無播放來源時絕不記錄

    if (!playUrl || playUrl.trim() === '' || !animeTitle || animeTitle.includes('待命') || animeTitle === '動漫劇院播放器') return;

    let cur = 0;

    let dur = 0;

    if (video && video.style.display !== 'none' && !isNaN(video.currentTime)) {

        cur = video.currentTime;

        dur = video.duration || 0;

    } else {

        cur = (typeof virtualDanmakuTime === 'number') ? virtualDanmakuTime : 0;

        dur = 0;

    }

    const currentCover = kazumiState.cover || (window.getFallbackAnimeCover ? window.getFallbackAnimeCover(animeTitle, 'anime') : '');

    window.saveWatchHistory(animeTitle, currentCover, epTitle, playUrl, cur, dur);

};

// 劇院待命畫面中渲染最近觀看摘要 (支援懸浮視窗與抽屜，寬度舒展展示所有紀錄並支援平滑向下滾動)

window.renderAnimeHistoryStandby = function() {

    const box = document.getElementById('animeRecentHistoryBox');

    if (!box) return;

    try {

        const history = window.getWatchHistoryList();

        // 即時同步懸浮按鈕計數徽章

        const fBadge = document.getElementById('theaterFloatingHistoryBadge');

        if (fBadge) fBadge.textContent = history.length;

        if (history.length === 0) {

            box.innerHTML = `

                <div class="card bg-black bg-opacity-70 border border-secondary border-opacity-50 p-4 text-center rounded-3">

                    <i class="bi bi-clock-history fs-3 text-danger opacity-75 mb-2"></i>

                    <div class="text-white-50 small mb-1">暫無最近觀看紀錄</div>

                    <div class="text-secondary" style="font-size: 0.72rem;">播放過的動漫、B站或 YouTube 影片將自動記錄於此</div>

                </div>

            `;

            return;

        }

        const formatSec = (s) => {

            if (!s || isNaN(s) || s < 0) return '00:00';

            const m = Math.floor(s / 60);

            const sec = Math.floor(s % 60);

            return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;

        };

        box.innerHTML = `

            <div class="d-flex flex-column gap-2 overflow-auto pe-1" style="max-height: 420px; min-height: 80px;">

                ${history.map((item) => {

                    const pct = (item.duration > 0 && item.currentTime > 0) ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) : 0;

                    const timeStr = item.currentTime > 0 ? `${formatSec(item.currentTime)} / ${item.duration > 0 ? formatSec(item.duration) : '--:--'}` : '剛開始';

                    let platformBadge = item.platform === 'youtube' 

                        ? `<span class="badge bg-danger text-nowrap" style="font-size:0.68rem;"><i class="bi bi-youtube me-1"></i>YT</span>` 

                        : item.platform === 'bilibili' 

                            ? `<span class="badge text-nowrap" style="font-size:0.68rem; background-color: #00aeec !important; color: #fff;"><i class="bi bi-tv me-1"></i>B站</span>` 

                            : `<span class="badge bg-warning text-dark text-nowrap" style="font-size:0.68rem;"><i class="bi bi-film me-1"></i>動漫</span>`;

                    const defaultImg = window.getFallbackAnimeCover ? window.getFallbackAnimeCover(item.title, item.platform) : '';

                    return `

                        <div class="d-flex align-items-center gap-2 p-2 rounded bg-black bg-opacity-60 border border-secondary border-opacity-40 hover-bg-light transition-all position-relative shadow-sm">

                            <img src="${escapeHtml(item.cover || defaultImg)}" 

                                 style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" 

                                 onerror="this.src='${escapeHtml(defaultImg)}'"

                                 alt="${escapeHtml(item.title)}">

                            <div class="flex-grow-1 overflow-hidden" style="min-width: 0;">

                                <div class="d-flex align-items-center gap-1 mb-1">

                                    ${platformBadge}

                                    <div class="fw-semibold text-white small text-truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>

                                </div>

                                <div class="d-flex align-items-center justify-content-between text-secondary small" style="font-size: 0.75rem;">

                                    <span class="history-ep-title-badge text-truncate me-2" style="max-width: 140px;" title="${escapeHtml(item.epTitle || '正片')}">${escapeHtml(item.epTitle || '正片')}</span>

                                    <span class="font-monospace text-warning text-nowrap">${pct > 0 ? pct + '%' : timeStr}</span>

                                </div>

                            </div>

                            <div class="d-flex align-items-center gap-1 flex-shrink-0 ms-1">

                                <button class="btn btn-sm btn-danger px-2 text-nowrap rounded-pill py-0 d-flex align-items-center gap-1" style="font-size: 0.72rem; height: 26px;" onclick="resumeWatchHistory('${item.id}'); toggleTheaterFloatingHistory(false);" title="繼續播放此進度">

                                    <i class="bi bi-play-fill"></i> 續播

                                </button>

                                <button type="button" class="btn btn-xs btn-outline-secondary border-0 p-1 text-white-50 hover-text-danger" onclick="deleteWatchHistoryItem('${item.id}', event)" title="刪除此紀錄">

                                    <i class="bi bi-x-lg"></i>

                                </button>

                            </div>

                        </div>

                    `;

                }).join('')}

            </div>

        `;

    } catch(e) {

        console.error('渲染動畫歷史失敗:', e);

    }

};

// 渲染獨立觀看歷史網格 (支援動漫專區 acg.html 與首頁模態框，緊湊精緻排版)

window.renderWatchHistoryGrid = function() {

    const containers = [

        document.getElementById('watchHistoryGrid'),

        document.getElementById('modalWatchHistoryGrid')

    ].filter(Boolean);

    if (containers.length === 0) return;

    const history = window.getWatchHistoryList();

    // 更新計數徽章

    const badges = [

        document.getElementById('watchHistoryBadge'),

        document.getElementById('modalWatchHistoryBadge'),

        document.getElementById('navWatchHistoryBadge')

    ].filter(Boolean);

    badges.forEach(b => {

        b.textContent = `${history.length} 部`;

    });

    const formatSec = (s) => {

        if (!s || isNaN(s) || s < 0) return '00:00';

        const m = Math.floor(s / 60);

        const sec = Math.floor(s % 60);

        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;

    };

    containers.forEach(container => {

        if (history.length === 0) {

            container.innerHTML = `

                <div class="col-12 py-5 text-center text-muted">

                    <i class="bi bi-clock-history fs-1 d-block mb-3 text-secondary opacity-50"></i>

                    <h6 class="fw-bold">目前尚無任何播放紀錄</h6>

                    <p class="small text-muted mb-0">當你在圖書館觀看動漫劇院、Bilibili 或 YouTube 影片時，系統會自動為你記錄集數與進度，隨時一鍵接續開播！</p>

                </div>

            `;

            return;

        }

        container.innerHTML = history.map((item) => {

            const pct = (item.duration > 0 && item.currentTime > 0) 

                ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) 

                : 0;

            const timeStr = item.currentTime > 0 

                ? `${formatSec(item.currentTime)} / ${item.duration > 0 ? formatSec(item.duration) : '--:--'}`

                : '剛剛開始';

            let platformBadge = '';

            if (item.platform === 'youtube') {

                platformBadge = `<span class="badge bg-danger watch-history-badge"><i class="bi bi-youtube me-1"></i>YouTube</span>`;

            } else if (item.platform === 'bilibili') {

                platformBadge = `<span class="badge watch-history-badge" style="background-color: #00aeec !important; color: #fff;"><i class="bi bi-tv me-1"></i>Bilibili</span>`;

            } else {

                platformBadge = `<span class="badge bg-warning text-dark watch-history-badge"><i class="bi bi-film me-1"></i>動漫劇院</span>`;

            }

            const defaultGridImg = window.getFallbackAnimeCover ? window.getFallbackAnimeCover(item.title, item.platform) : '';

            return `

                <div class="col-6 col-md-4 col-lg-3 col-xl-2">

                    <div class="card watch-history-card watch-history-card-compact h-100 shadow-sm border-0 position-relative">

                        <div class="watch-history-cover-wrap">

                            ${platformBadge}

                            <button type="button" class="watch-history-del-btn" onclick="deleteWatchHistoryItem('${item.id}', event)" title="刪除此紀錄">

                                <i class="bi bi-x-lg"></i>

                            </button>

                            <img src="${escapeHtml(item.cover || defaultGridImg)}" 

                                 class="watch-history-cover" 

                                 alt="${escapeHtml(item.title)}" 

                                 loading="lazy" 

                                 onerror="this.src='${escapeHtml(defaultGridImg)}'">

                            <div class="watch-history-progress-bar">

                                <div class="watch-history-progress-fill" style="width: ${pct}%;"></div>

                            </div>

                        </div>

                        <div class="card-body p-2 d-flex flex-column">

                            <h6 class="fw-bold mb-1 text-truncate" title="${escapeHtml(item.title)}" style="font-size: 0.82rem;">${escapeHtml(item.title)}</h6>

                            <div class="history-ep-title-badge text-truncate mb-1">${escapeHtml(item.epTitle || '')}</div>

                            <div class="d-flex align-items-center justify-content-between text-muted small mt-auto mb-2" style="font-size: 0.72rem;">

                                <span><i class="bi bi-clock me-1"></i>${timeStr}</span>

                                <span class="fw-bold text-secondary">${pct > 0 ? pct + '%' : '未看完'}</span>

                            </div>

                            <button class="btn btn-danger btn-sm rounded-pill w-100 fw-semibold d-flex align-items-center justify-content-center gap-1 shadow-sm" onclick="resumeWatchHistory('${item.id}')">

                                <i class="bi bi-play-fill fs-6"></i> 繼續播放

                            </button>

                        </div>

                    </div>

                </div>

            `;

        }).join('');

    });

};

// 接續恢復觀看

window.resumeWatchHistory = function(id) {

    const history = window.getWatchHistoryList();

    const item = history.find(h => h.id === id) || history[parseInt(id, 10)];

    if (!item) return;

    // 關閉歷史模態框 (若處於開啟狀態)

    const modalEl = document.getElementById('watchHistoryModal');

    if (modalEl) {

        const m = bootstrap.Modal.getInstance(modalEl);

        if (m) m.hide();

    }

    if (item.platform === 'anime' && item.playUrl && !item.playUrl.includes('bilibili') && !item.playUrl.includes('youtube')) {

        openTheaterWithUrl(item.title, item.epTitle, item.playUrl, [], null, item.cover || '');

        const video = document.getElementById("kazumiVideoPlayer");

        if (video && item.currentTime > 0) {

            const onLoaded = () => {

                video.removeEventListener('loadedmetadata', onLoaded);

                video.currentTime = item.currentTime;

            };

            video.addEventListener('loadedmetadata', onLoaded);

        }

    } else {

        openKazumiPlayer(item.title, item.playUrl);

        const video = document.getElementById("kazumiVideoPlayer");

        if (video && item.currentTime > 0) {

            const onLoaded = () => {

                video.removeEventListener('loadedmetadata', onLoaded);

                video.currentTime = item.currentTime;

            };

            video.addEventListener('loadedmetadata', onLoaded);

        }

    }

};

// 向下相容單筆接續

window.resumeAnimeHistory = function(idx = 0) {

    const history = window.getWatchHistoryList();

    if (history[idx]) {

        window.resumeWatchHistory(history[idx].id);

    }

};

window.deleteWatchHistoryItem = function(id, e) {

    if (e) { e.preventDefault(); e.stopPropagation(); }

    let history = window.getWatchHistoryList();

    history = history.filter(h => h.id !== id);

    localStorage.setItem('web_library_watch_history', JSON.stringify(history));

    window.renderWatchHistoryGrid();

    window.renderAnimeHistoryStandby();

    showToast("已刪除該筆觀看紀錄", "bi-trash text-secondary");

};

window.clearAllWatchHistory = function() {

    if (!confirm("確定要清空所有動漫、Bilibili 與 YouTube 的播放歷史紀錄嗎？")) return;

    localStorage.removeItem('web_library_watch_history');

    localStorage.removeItem('web_library_anime_history');

    window.renderWatchHistoryGrid();

    window.renderAnimeHistoryStandby();

    showToast("已清空全部觀看紀錄！", "bi-trash-fill text-danger");

};

window.clearAnimeHistory = function() {

    window.clearAllWatchHistory();

};

window.openWatchHistoryModal = function(e) {

    if (e) {

        try { e.preventDefault(); e.stopPropagation(); } catch(_) {}

    }

    window.renderWatchHistoryGrid();

    const modalEl = document.getElementById('watchHistoryModal');

    if (modalEl) {

        const theaterModal = document.getElementById("animePlayerModal");

        const isTheaterOpen = theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block");

        if (isTheaterOpen) {

            document.body.classList.add("has-multi-modal");

            modalEl.style.zIndex = '1070';

        }

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl, { focus: false });

        modal.show();

        if (isTheaterOpen) {

            setTimeout(() => {

                const backdrops = document.querySelectorAll('.modal-backdrop');

                if (backdrops.length > 1) {

                    backdrops[backdrops.length - 1].style.zIndex = '1065';

                }

            }, 50);

        }

    }

};

// 確保歷史模態框關閉時若劇院仍開啟，維持 body.modal-open 防止畫面滑動或焦點錯亂

const whModalEl = document.getElementById('watchHistoryModal');

if (whModalEl) {

    whModalEl.addEventListener('hidden.bs.modal', () => {

        document.body.classList.remove("has-multi-modal");

        const theaterModal = document.getElementById("animePlayerModal");

        if (theaterModal && (theaterModal.classList.contains("show") || theaterModal.style.display === "block")) {

            document.body.classList.add("modal-open");

        }

    });

}

// 漫畫歷史紀錄系統

window.saveMangaReadHistory = function(mangaId, title, cover, chapterTitle, chapterIndex) {

    if (!title || title.trim() === "") return;

    try {

        let history = JSON.parse(localStorage.getItem('web_library_manga_history') || '[]');

        history = history.filter(h => h.mangaId !== mangaId && h.title !== title);

        history.unshift({

            mangaId,

            title: title.trim(),

            cover: cover || "",

            chapterTitle: chapterTitle || "第 1 話",

            chapterIndex: chapterIndex || 0,

            updatedAt: Date.now()

        });

        if (history.length > 20) history = history.slice(0, 20);

        localStorage.setItem('web_library_manga_history', JSON.stringify(history));

        window.renderMangaHistoryStandby();

    } catch(e) {

        console.error('儲存漫畫閱讀歷史失敗:', e);

    }

};

window.renderMangaHistoryStandby = function() {

    const box = document.getElementById('mangaRecentHistoryBox');

    if (!box) return;

    try {

        const history = JSON.parse(localStorage.getItem('web_library_manga_history') || '[]');

        if (history.length === 0) {

            box.style.display = 'none';

            box.innerHTML = '';

            return;

        }

        box.style.display = 'block';

        box.innerHTML = `

            <div class="card bg-black bg-opacity-75 border border-primary border-opacity-50 p-2 shadow-sm rounded-3">

                <div class="d-flex align-items-center justify-content-between mb-2 pb-1 border-bottom border-secondary border-opacity-25">

                    <small class="text-primary fw-bold"><i class="bi bi-clock-history me-1"></i>漫畫閱讀歷史紀錄 (${history.length})</small>

                    <button type="button" class="btn btn-link btn-xs text-secondary p-0 text-decoration-none" onclick="clearMangaHistory()" title="清除全部紀錄">清除全部</button>

                </div>

                <div class="d-flex flex-column gap-2" style="max-height: 220px; overflow-y: auto; scrollbar-width: thin;">

                    ${history.map((item, idx) => `

                        <div class="d-flex align-items-center gap-2 p-1 rounded-2 bg-dark bg-opacity-50 border border-secondary border-opacity-25" style="transition: background 0.15s;">

                            <img src="${escapeHtml(item.cover || "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='400' viewBox='0 0 300 400'%3E%3Crect fill='%231e293b' width='300' height='400'/%3E%3Cpath fill='%230284c7' d='M150 180c-20-10-50-10-70 0v60c20-10 50-10 70 0m0-60c20-10 50-10 70 0v60c-20-10-50-10-70 0' stroke='%230284c7' stroke-width='6' fill='none'/%3E%3Ctext x='50%25' y='75%25' fill='%2394a3b8' font-family='sans-serif' font-size='14' text-anchor='middle'%3E漫畫書籍%3C/text%3E%3C/svg%3E")}" style="width: 38px; height: 50px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" onerror="this.src='data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'400\' viewBox=\'0 0 300 400\'%3E%3Crect fill=\'%231e293b\' width=\'300\' height=\'400\'/%3E%3Cpath fill=\'%230284c7\' d=\'M150 180c-20-10-50-10-70 0v60c20-10 50-10 70 0m0-60c20-10 50-10 70 0v60c-20-10-50-10-70 0\' stroke=\'%230284c7\' stroke-width=\'6\' fill=\'none\'/%3E%3Ctext x=\'50%25\' y=\'75%25\' fill=\'%2394a3b8\' font-family=\'sans-serif\' font-size=\'14\' text-anchor=\'middle\'%3E漫畫書籍%3C/text%3E%3C/svg%3E'">

                            <div class="flex-grow-1 overflow-hidden">

                                <div class="fw-semibold text-white small text-truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>

                                <div class="text-primary small text-truncate" style="font-size: 0.75rem;">${escapeHtml(item.chapterTitle || '第 1 話')}</div>

                            </div>

                            <div class="d-flex align-items-center gap-1 flex-shrink-0">

                                <button class="btn btn-xs btn-primary px-2 text-nowrap rounded-pill" onclick="resumeMangaHistory(${idx})">

                                    <i class="bi bi-book-half"></i> 閱讀

                                </button>

                                <button class="btn btn-xs btn-link text-white-50 p-1" onclick="removeMangaHistoryItem(${idx})" title="刪除此紀錄">

                                    <i class="bi bi-x-lg" style="font-size: 0.75rem;"></i>

                                </button>

                            </div>

                        </div>

                    `).join('')}

                </div>

            </div>

        `;

    } catch(e) {

        console.error('渲染漫畫歷史失敗:', e);

    }

};

window.removeMangaHistoryItem = function(idx) {

    try {

        let history = JSON.parse(localStorage.getItem('web_library_manga_history') || '[]');

        if (idx >= 0 && idx < history.length) {

            history.splice(idx, 1);

            localStorage.setItem('web_library_manga_history', JSON.stringify(history));

            window.renderMangaHistoryStandby();

        }

    } catch(e) {

        console.error('刪除單筆漫畫歷史失敗:', e);

    }

};

window.resumeMangaHistory = function(idx = 0) {

    try {

        const history = JSON.parse(localStorage.getItem('web_library_manga_history') || '[]');

        const item = history[idx];

        if (!item) return;

        selectManga(item.mangaId, item.title, item.cover, "");

        setTimeout(() => {

            if (mangaState.chapters && mangaState.chapters[item.chapterIndex]) {

                const targetCh = mangaState.chapters[item.chapterIndex];

                loadMangaChapter(item.mangaId, targetCh.id, targetCh.title, item.chapterIndex);

            } else if (mangaState.chapters && mangaState.chapters.length > 0) {

                const matched = mangaState.chapters.find(c => c.title === item.chapterTitle);

                const target = matched || mangaState.chapters[0];

                loadMangaChapter(item.mangaId, target.id, target.title, 0);

            }

        }, 700);

    } catch(e) {

        console.error('恢復閱讀失敗:', e);

    }

};

window.clearMangaHistory = function() {

    localStorage.removeItem('web_library_manga_history');

    window.renderMangaHistoryStandby();

    showToast("已清除漫畫閱讀歷史！", "bi-trash text-secondary");

};

// 相容性全域函式守護 (預防歷史模組與 ACG 擴充調用 ReferenceError)

window.saveBookmarksLocally = function() {

    saveToStorage(true);

};

window.renderCategoryTabs = function() {

    updateUI();

};

// 匯入書籤 JSON 支援

window.handleImportBookmarks = function(event) {

    const file = event.target.files && event.target.files[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = async function(e) {

        try {

            const rawData = JSON.parse(e.target.result);

            let importedList = [];

            if (Array.isArray(rawData)) {

                importedList = rawData;

            } else if (rawData && Array.isArray(rawData.bookmarks)) {

                importedList = rawData.bookmarks;

            } else if (rawData && typeof rawData === 'object') {

                importedList = Object.values(rawData).filter(v => v && typeof v === 'object' && (v.title || v.url));

            }

            if (!importedList || importedList.length === 0) {

                showToast("匯入的 JSON 檔案中未發現有效書籤資料！", "bi-exclamation-triangle text-warning");

                return;

            }

            let addedCount = 0;

            let updatedCount = 0;

            importedList.forEach(item => {

                if (!item || !item.url) return;

                const existingIdx = state.bookmarks.findIndex(b => (item.id && b.id === item.id) || (b.url && b.url === item.url));

                const normalizedItem = {

                    id: item.id || ('bm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5)),

                    title: item.title || item.name || '未命名書籤',

                    url: item.url,

                    cover: item.cover || '',

                    category: item.category || 'other',

                    tags: Array.isArray(item.tags) ? item.tags : [],

                    desc: item.desc || item.description || '',

                    pinned: !!item.pinned,

                    clicks: item.clicks || 0,

                    createdAt: item.createdAt || new Date().toISOString()

                };

                if (existingIdx >= 0) {

                    state.bookmarks[existingIdx] = { ...state.bookmarks[existingIdx], ...normalizedItem };

                    updatedCount++;

                } else {

                    state.bookmarks.unshift(normalizedItem);

                    addedCount++;

                }

            });

            // 1. 本地儲存與伺服器同步

            saveToStorage(true);

            // 2. 刷新整體 UI、統計數字與分類籤

            updateUI();

            showToast(`🎉 成功匯入書籤！新增 ${addedCount} 筆，更新 ${updatedCount} 筆`, "bi-file-earmark-check-fill text-success");

        } catch(err) {

            console.error('匯入書籤解析失敗:', err);

            showToast("匯入失敗：JSON 格式無效或檔案損毀！", "bi-x-circle text-danger");

        } finally {

            event.target.value = '';

        }

    };

    reader.readAsText(file, "UTF-8");

};

// 頁面初始化自動渲染歷史紀錄

document.addEventListener("DOMContentLoaded", () => {

    setTimeout(() => {

        if (typeof window.renderAnimeHistoryStandby === 'function') window.renderAnimeHistoryStandby();

        if (typeof window.renderWatchHistoryGrid === 'function') window.renderWatchHistoryGrid();

        if (typeof window.renderMangaHistoryStandby === 'function') window.renderMangaHistoryStandby();

    }, 100);

});

// 啟動應用

document.addEventListener("DOMContentLoaded", initApp);

// ==========================================

// ACG 專區：遊戲專區與工具攻略庫 (Game Hub)

// ==========================================

const DEFAULT_ACG_GAMES = [

    {

        id: 'game_fgo_chaldea',

        title: 'Fate/Grand Order - Chaldea 迦勒底',

        url: 'https://chaldea.center/',

        badge: 'FGO 官方/開源神器',

        badgeClass: 'bg-danger text-white',

        tags: ['FGO', '迦勒底', '素材規劃', '從者養成', '活動周回'],

        desc: '跨平台開源 FGO 規劃工具，支援從者養成計算、素材需求掉落統計、活動周回規劃與抽卡模擬，支援在當前視窗即開即用！',

        isCustom: false

    },

    {

        id: 'game_fgo_mooncell',

        title: 'Mooncell Wiki - FGO 繁簡中文百科',

        url: 'https://fgo.wiki/',

        badge: '權威百科',

        badgeClass: 'bg-primary text-white',

        tags: ['FGO', '中文百科', '指令卡數據', '關卡掉落'],

        desc: '中文圈最詳盡的 Fate/Grand Order 中文資料庫，完整收錄從者數值、指令卡參數、寶具傷害、敵方配置與最新活動攻略。',

        isCustom: false

    },

    {

        id: 'game_mfme_wiki',

        title: '魔法紀錄：魔法少女小圓外傳 - GameKee 攻略百科',

        url: 'https://www.gamekee.com/mfme/',

        badge: 'Wiki 百科',

        badgeClass: 'bg-danger-subtle text-danger border border-danger-subtle',

        tags: ['魔法紀錄', '小圓外傳', 'GameKee', '角色圖鑑', '活動攻略'],

        desc: '魔法少女小圓外傳最齊全的中文圖鑑與攻略站，收錄魔法少女養成數據、記憶結晶評價與活動關卡打法。',

        isCustom: false

    },

    {

        id: 'game_bilibili_fx_toy',

        title: 'FX 簡單！(外匯模擬交易) - Bilibili Toy',

        url: 'https://www.bilibili.com/toy/fx-simple/index.html',

        badge: 'B站小遊戲',

        badgeClass: 'bg-info-subtle text-info border border-info-subtle',

        tags: ['Bilibili', '外匯模擬', '趣味挑戰', '互動網頁'],

        desc: 'Bilibili Toy 推出之趣味外匯模擬交易小遊戲，輕鬆體驗低買高賣的刺激心跳！',

        isCustom: false,

        openInNewTab: true

    },

    {

        id: 'game_powerful_wind_cabbages',

        title: '強風大背頭',

        url: 'https://asyncfish.itch.io/powerful-wind-slicked-back-cabbages',

        badge: '節奏獨立小遊戲',

        badgeClass: 'bg-success-subtle text-success border border-success-subtle',

        tags: ['強風大背頭', '節奏', '獨立小遊戲', 'Itch.io'],

        desc: '節奏獨立小遊戲。由迷因神曲《強風大背頭》改編的魔性節奏獨立小遊戲，畫風超可愛治癒！',

        isCustom: false,

        openInNewTab: true

    },

    {

        id: 'game_dabuchi_unityroom',

        title: '狂吃雙吉堡 (ダブチを食べまくるゲーム)',

        url: 'https://unityroom.com/games/dabuchitabemakurugame',

        badge: 'Unity 遊戲',

        badgeClass: 'bg-warning-subtle text-warning border border-warning-subtle',

        tags: ['Unityroom', '雙吉堡', '吃漢堡', '休閒挑戰'],

        desc: '日本 Unityroom 熱門小遊戲「ダブチを食べまくるゲーム」（狂吃麥當勞雙層牛肉吉事堡），操控角色爽快狂吃漢堡挑戰最高得分！',

        isCustom: false,

        openInNewTab: true

    }

];

function getGameHubItems() {

    try {

        const hiddenDefaults = JSON.parse(localStorage.getItem('web_library_hidden_default_games') || '[]');

        const visibleDefaults = DEFAULT_ACG_GAMES.filter(g => !hiddenDefaults.includes(g.id));

        const stored = JSON.parse(localStorage.getItem('web_library_custom_games') || '[]');

        return [...visibleDefaults, ...stored];

    } catch (e) {

        return DEFAULT_ACG_GAMES;

    }

}

window.openGameHubModal = function() {

    window.renderGameHubGrid();

    const modalEl = document.getElementById("gameHubModal");

    if (modalEl) {

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        modal.show();

    }

};

window.renderGameHubGrid = function(keyword = '') {

    const container = document.getElementById("gameHubGridContainer");

    if (!container) return;

    const term = (keyword || '').trim().toLowerCase();

    const items = getGameHubItems();

    const filtered = items.filter(g => {

        if (!term) return true;

        return g.title.toLowerCase().includes(term) ||

               g.desc.toLowerCase().includes(term) ||

               (Array.isArray(g.tags) && g.tags.some(t => t.toLowerCase().includes(term)));

    });

    container.innerHTML = "";

    filtered.forEach(game => {

        const isExternal = !!(game.openInNewTab || (game.url && (game.url.includes('itch.io') || game.url.includes('unityroom.com') || game.url.includes('bilibili.com/toy'))));

        const col = document.createElement("div");

        col.className = "col";

        col.innerHTML = `

            <div class="card h-100 border border-secondary border-opacity-50 shadow-sm rounded-3 overflow-hidden text-white" style="background: #1e293b; transition: transform 0.2s, box-shadow 0.2s;">

                <div class="card-body p-3 d-flex flex-column">

                    <div class="d-flex align-items-center justify-content-between mb-2">

                        <span class="badge ${game.badgeClass || 'bg-warning text-dark fw-bold'}">${escapeHtml(game.badge || '熱門工具')}</span>

                        <span class="small text-white-50"><i class="bi bi-controller fs-6 text-warning"></i></span>

                    </div>

                    <h6 class="fw-bold mb-1 text-white">${escapeHtml(game.title)}</h6>

                    <div class="mb-2 d-flex flex-wrap gap-1">

                        ${(game.tags || []).map(t => `<span class="badge bg-secondary-subtle text-light border border-secondary border-opacity-50 small" style="font-size: 0.68rem;">${escapeHtml(t)}</span>`).join('')}

                    </div>

                    <p class="small text-white-50 mb-3 flex-grow-1" style="font-size: 0.8rem; line-height: 1.45; color: #cbd5e1 !important;">

                        ${escapeHtml(game.desc)}

                    </p>

                    <div class="d-flex gap-2 mt-auto pt-2 border-top border-secondary border-opacity-25">

                        ${isExternal ? `

                        <button class="btn btn-sm btn-primary flex-grow-1 rounded-pill fw-semibold shadow-sm" onclick="window.open('${escapeHtml(game.url)}', '_blank')">

                            <i class="bi bi-box-arrow-up-right"></i> 開啟暢玩

                        </button>

                        ` : `

                        <button class="btn btn-sm btn-primary flex-grow-1 rounded-pill fw-semibold shadow-sm" onclick="openGameToolViewer('${escapeHtml(game.title)}', '${escapeHtml(game.url)}')">

                            <i class="bi bi-window-fullscreen"></i> 在線開啟

                        </button>

                        <button class="btn btn-sm btn-outline-info rounded-pill px-3" onclick="window.open('${escapeHtml(game.url)}', '_blank')" title="另開新分頁跳轉原網頁">

                            <i class="bi bi-box-arrow-up-right"></i> 跳轉

                        </button>

                        `}

                        <button class="btn btn-sm btn-outline-danger rounded-pill px-2" onclick="deleteGameHubCard('${game.id}', ${!!game.isCustom})" title="${game.isCustom ? '刪除自定義卡片' : '移除此預設卡片'}">

                            <i class="bi bi-trash"></i>

                        </button>

                    </div>

                </div>

            </div>

        `;

        container.appendChild(col);

    });

    // 最後添加「新增自定義遊戲 / Wiki 卡片插槽」

    const addCol = document.createElement("div");

    addCol.className = "col";

    addCol.innerHTML = `

        <div class="card h-100 border border-secondary border-opacity-50 shadow-sm rounded-3 d-flex flex-column align-items-center justify-content-center p-4 text-center cursor-pointer" style="background: rgba(30, 41, 59, 0.45); border-style: dashed !important; min-height: 180px; cursor: pointer; transition: background 0.2s;" onclick="openAddCustomGameModal()" title="點擊新增您喜愛的遊戲攻略或資料庫">

            <i class="bi bi-plus-circle-dotted fs-1 text-warning mb-2 opacity-75"></i>

            <h6 class="fw-bold text-white mb-1">新增自定義遊戲 / Wiki</h6>

            <p class="small text-white-50 mb-0" style="font-size: 0.78rem; color: #94a3b8 !important;">可自訂加入任何遊戲 Wiki 百科、素材工具或地圖</p>

        </div>

    `;

    container.appendChild(addCol);

};

window.filterGameHubGrid = function(keyword) {

    window.renderGameHubGrid(keyword);

};

window.openGameToolViewer = function(title, url) {

    if (!url) return;

    if (url.includes('itch.io') || url.includes('unityroom.com') || url.includes('bilibili.com/toy')) {

        window.open(url, '_blank');

        return;

    }

    window.currentGameToolUrl = url;

    const modalTitle = document.getElementById("gameToolModalTitle");

    const iframe = document.getElementById("gameToolIframe");

    const indicator = document.getElementById("gameToolLoadingIndicator");

    if (modalTitle) modalTitle.textContent = title;

    if (indicator) indicator.style.display = "block";

    if (iframe) {

        iframe.onload = () => {

            if (indicator) indicator.style.display = "none";

        };

        iframe.src = url;

    }

    // 關閉清單 Modal 並展示工具視窗

    const hubModalEl = document.getElementById("gameHubModal");

    if (hubModalEl) {

        const hubModal = bootstrap.Modal.getInstance(hubModalEl);

        if (hubModal) hubModal.hide();

    }

    const toolModalEl = document.getElementById("gameToolModal");

    if (toolModalEl) {

        const toolModal = bootstrap.Modal.getOrCreateInstance(toolModalEl);

        toolModal.show();

    }

};

window.reloadGameToolIframe = function() {

    const iframe = document.getElementById("gameToolIframe");

    const indicator = document.getElementById("gameToolLoadingIndicator");

    if (iframe && window.currentGameToolUrl) {

        if (indicator) indicator.style.display = "block";

        iframe.src = window.currentGameToolUrl;

    }

};

window.openGameToolInNewTab = function() {

    if (window.currentGameToolUrl) {

        window.open(window.currentGameToolUrl, '_blank', 'noopener,noreferrer');

    }

};

window.backToGameHub = function() {

    const toolModalEl = document.getElementById("gameToolModal");

    if (toolModalEl) {

        const toolModal = bootstrap.Modal.getInstance(toolModalEl);

        if (toolModal) toolModal.hide();

    }

    const iframe = document.getElementById("gameToolIframe");

    if (iframe) iframe.src = "about:blank"; // 釋放記憶體

    setTimeout(() => {

        window.openGameHubModal();

    }, 150);

};

window.closeGameToolViewer = function() {

    const iframe = document.getElementById("gameToolIframe");

    if (iframe) iframe.src = "about:blank";

};

window.openAddCustomGameModal = function() {

    const nameInput = document.getElementById("customGameNameInput");

    const urlInput = document.getElementById("customGameUrlInput");

    const tagsInput = document.getElementById("customGameTagsInput");

    const descInput = document.getElementById("customGameDescInput");

    if (nameInput) nameInput.value = "";

    if (urlInput) urlInput.value = "";

    if (tagsInput) tagsInput.value = "";

    if (descInput) descInput.value = "";

    const modalEl = document.getElementById("addCustomGameModal");

    if (modalEl) {

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        modal.show();

    }

};

window.saveCustomGame = function() {

    const nameInput = document.getElementById("customGameNameInput");

    const urlInput = document.getElementById("customGameUrlInput");

    const tagsInput = document.getElementById("customGameTagsInput");

    const descInput = document.getElementById("customGameDescInput");

    const title = nameInput ? nameInput.value.trim() : '';

    let url = urlInput ? urlInput.value.trim() : '';

    const tagsStr = tagsInput ? tagsInput.value.trim() : '';

    const desc = descInput ? descInput.value.trim() : '';

    if (!title || !url) {

        showToast("請填寫遊戲名稱與工具網址！", "bi-exclamation-triangle text-warning");

        return;

    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {

        url = 'https://' + url;

    }

    const tags = tagsStr ? tagsStr.split(/[,，\s]+/).filter(Boolean) : ['自定義'];

    const newGame = {

        id: 'custom_game_' + Date.now(),

        title,

        url,

        badge: '自定義',

        badgeClass: 'bg-secondary text-white',

        tags,

        desc: desc || '使用者自定義加入之遊戲工具或 Wiki 資料庫。',

        isCustom: true

    };

    try {

        const stored = JSON.parse(localStorage.getItem('web_library_custom_games') || '[]');

        stored.push(newGame);

        localStorage.setItem('web_library_custom_games', JSON.stringify(stored));

        showToast(`🎉 已成功加入《${title}》至遊戲專區！`, "bi-check-circle-fill text-success");

        const modalEl = document.getElementById("addCustomGameModal");

        if (modalEl) {

            const modal = bootstrap.Modal.getInstance(modalEl);

            if (modal) modal.hide();

        }

        window.renderGameHubGrid();

    } catch (e) {

        showToast("儲存失敗：" + e.message, "bi-x-circle text-danger");

    }

};

window.deleteGameHubCard = function(id, isCustom) {

    if (!confirm(isCustom ? "確定要刪除此自定義遊戲卡片嗎？" : "確定要從清單移除此預設遊戲卡片嗎？（之後可點擊上方「恢復預設」隨時還原）")) return;

    try {

        if (isCustom) {

            let stored = JSON.parse(localStorage.getItem('web_library_custom_games') || '[]');

            stored = stored.filter(g => g.id !== id);

            localStorage.setItem('web_library_custom_games', JSON.stringify(stored));

            showToast("已刪除該自定義遊戲卡片", "bi-trash3 text-info");

        } else {

            let hidden = JSON.parse(localStorage.getItem('web_library_hidden_default_games') || '[]');

            if (!hidden.includes(id)) {

                hidden.push(id);

                localStorage.setItem('web_library_hidden_default_games', JSON.stringify(hidden));

            }

            showToast("已移除該預設遊戲卡片（可隨時點擊「恢復預設」還原）", "bi-trash3 text-warning");

        }

        window.renderGameHubGrid();

    } catch (e) {

        console.error("移除遊戲卡片失敗:", e);

    }

};

window.deleteCustomGame = function(id) {

    window.deleteGameHubCard(id, true);

};

window.resetDefaultGames = function() {

    localStorage.removeItem('web_library_hidden_default_games');

    showToast("🎉 已成功恢復所有預設遊戲卡片！", "bi-arrow-counterclockwise text-success");

    window.renderGameHubGrid();

};

// 當前小說一鍵收進書房 (全域通用：支援線上與本機電子書)

window.toggleCurrentNovelToBookshelf = async function() {

    if (!novelState.currentNovel || !novelState.currentNovel.title) {

        if (typeof showToast === 'function') {

            showToast("目前尚未開啟任何小說！", "bi-exclamation-circle text-info");

        }

        return;

    }

    const cur = novelState.currentNovel;

    let shelf = window.getNovelBookshelf ? window.getNovelBookshelf() : [];

    if (shelf.some(b => b.title === cur.title)) {

        if (typeof showToast === 'function') {

            showToast(`《${cur.title}》已在您的小說書房中！`, "bi-bookmark-check text-success");

        }

        return;

    }

    const isLocal = !!cur.isLocal;

    const bookId = cur.id || (isLocal ? ('local_' + cur.title.replace(/\s+/g, '_')) : ('online_' + cur.title));

    // 若為本機上傳，確保完整章節寫入 IndexedDB

    if (isLocal && novelState.chapters && novelState.chapters.length > 0) {

        await saveLocalNovelToDB({

            id: bookId,

            title: cur.title,

            chapters: novelState.chapters,

            isLocal: true,

            updatedAt: new Date().toISOString()

        });

    }

    shelf.unshift({

        id: bookId,

        title: cur.title,

        cover: cur.cover || "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=400&q=80",

        tag: isLocal ? "本機上傳" : "線上輕小說",

        isLocal: isLocal,

        source: isLocal ? "local" : (cur.source || "online")

    });

    if (window.saveNovelBookshelf) {

        window.saveNovelBookshelf(shelf);

    }

    if (typeof showToast === 'function') {

        showToast(`🎉 成功將${isLocal ? '本機小說' : '線上小說'}《${cur.title}》收藏進小說立體書房！`, "bi-star-fill text-warning");

    }

};

// ==================== Docker 容器生命週期控制 (Port 8090) ====================
let lastDockerOutput = { cmd: '', output: '', status: '' };

window.checkDockerStatus = async function(isManual = false) {
    const badge = document.getElementById("dockerStatusBadge");
    if (!badge) return;
    try {
        const res = await fetch('/api/docker/status');
        if (!res.ok) throw new Error('伺服器未運行');
        const data = await res.json();
        if (data.running) {
            badge.className = "badge bg-success rounded-pill";
            badge.textContent = "運行中 (Running)";
        } else if (data.exists) {
            badge.className = "badge bg-warning text-dark rounded-pill";
            badge.textContent = "已停止 (Stopped)";
        } else {
            badge.className = "badge bg-secondary rounded-pill";
            badge.textContent = "未建立 (Not Built)";
        }
        if (isManual && typeof showToast === 'function') {
            showToast(`Docker 狀態：${badge.textContent}`, "bi-box-seam text-primary");
        }
    } catch (e) {
        badge.className = "badge bg-secondary rounded-pill";
        badge.textContent = "離線 (8090)";
    }
};

window.executeDockerAction = async function(action) {
    const actionNames = {
        up: '一鍵部署並啟動 (Up)',
        start: '啟動容器 (Start)',
        stop: '關閉容器 (Stop)',
        restart: '重啟容器 (Restart)',
        down: '移除容器 (Down)'
    };
    const title = actionNames[action] || action;
    if (typeof showToast === 'function') {
        showToast(`正在執行 Docker ${title}... 請稍候`, "bi-hourglass-split text-info");
    }

    try {
        const res = await fetch('/api/docker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        lastDockerOutput = {
            cmd: data.command || `docker compose ${action}`,
            output: data.output || (data.success ? '指令執行成功！' : data.message),
            status: data.success ? '成功 (Success)' : '警告/錯誤 (Error)'
        };

        if (data.success) {
            if (typeof showToast === 'function') {
                showToast(`Docker ${title} 成功完成！`, "bi-check-circle-fill text-success");
            }
        } else {
            if (typeof showToast === 'function') {
                showToast(`Docker 執行警報：${data.error || '請檢查日誌'}`, "bi-exclamation-triangle-fill text-warning");
            }
        }

        window.checkDockerStatus();
        window.openDockerLogsModal();
    } catch (e) {
        lastDockerOutput = {
            cmd: `docker compose ${action}`,
            output: `無法連線至本地後端 API (/api/docker/action)。\n原因：${e.message}\n\n【提示】若您正在離線瀏覽或伺服器尚未啟動，您可直接在終端機中執行：\n  docker compose ${action === 'up' ? 'up -d --build' : action}`,
            status: '離線提示'
        };
        if (typeof showToast === 'function') {
            showToast(`後端未連線，已生成終端機指令`, "bi-info-circle text-secondary");
        }
        window.openDockerLogsModal();
    }
};

window.confirmDockerDown = function() {
    if (confirm("確定要移除 (Down) Web Library Docker 容器嗎？\n（放心：./data 目錄中的書籤與帳號會完整保留，不會遺失）")) {
        window.executeDockerAction('down');
    }
};

window.openDockerLogsModal = function() {
    const modalEl = document.getElementById("dockerOutputModal");
    if (!modalEl) return;
    const cmdEl = document.getElementById("dockerOutputCmd");
    const contentEl = document.getElementById("dockerOutputContent");
    const badgeEl = document.getElementById("dockerOutputStatusBadge");

    if (cmdEl) cmdEl.textContent = `指令：${lastDockerOutput.cmd || 'docker compose ...'}`;
    if (contentEl) contentEl.textContent = lastDockerOutput.output || '尚無執行紀錄，請從右上角選單派發操作。';
    if (badgeEl) {
        badgeEl.textContent = lastDockerOutput.status || '就緒';
        badgeEl.className = lastDockerOutput.status?.includes('成功') ? 'badge bg-success' : (lastDockerOutput.status?.includes('錯誤') ? 'badge bg-danger' : 'badge bg-primary');
    }

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
};

// 頁面載入後自動偵測一次 Docker 狀態
setTimeout(() => {
    if (typeof window.checkDockerStatus === 'function') {
        window.checkDockerStatus();
    }
}, 1200);
