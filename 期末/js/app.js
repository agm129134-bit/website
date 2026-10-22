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
    viewMode: "grid", // 'grid' | 'list'
    currentUser: "期末展示學生",
    apiToken: "usr_tok_8f92ab3c71e041d8b991a",
    isBatchMode: false,
    selectedBookmarkIds: new Set()
};

// ==========================================
// 3. 初始化與本地存儲 (Storage)
// ==========================================
function initApp() {
    loadFromStorage();
    // 只有在首頁（存在 bookmarkContainer 與 categoryNav）時才初始化首頁 UI 與事件監聽
    if (document.getElementById("bookmarkContainer") && document.getElementById("categoryNav")) {
        setupEventListeners();
        updateUI();
    }
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
            if (authUser && (authUser.name || authUser.username)) {
                state.currentUser = authUser.name || authUser.username;
            }
        } catch (e) {}
    } else {
        const savedUser = localStorage.getItem("web_library_user");
        if (savedUser) state.currentUser = savedUser;
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

function saveToStorage() {
    localStorage.setItem("web_library_bookmarks", JSON.stringify(state.bookmarks));
    localStorage.setItem("web_library_user", state.currentUser);
    localStorage.setItem("web_library_token", state.apiToken);
}

// ==========================================
// 4. UI 渲染邏輯 (Card Rendering)
// ==========================================
function updateUI() {
    if (!document.getElementById("bookmarkContainer")) return;
    updateStats();
    renderTagChips();
    renderBookmarks();
    const navUsername = document.getElementById("navUsername");
    if (navUsername) navUsername.textContent = state.currentUser;
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

    // 1. 分類過濾
    if (state.activeCategory !== "all") {
        if (state.activeCategory === "anime") {
            result = result.filter(isAnimeItem);
        } else if (state.activeCategory === "resource") {
            result = result.filter(b => b.category === "resource" && !isAnimeItem(b));
        } else {
            result = result.filter(b => b.category === state.activeCategory && !isAnimeItem(b));
        }
    }

    // 2. 標籤過濾
    if (state.activeTag !== "all") {
        result = result.filter(b => Array.isArray(b.tags) && b.tags.includes(state.activeTag));
    }

    // 3. 搜尋字串比對 (標題、網址、描述或標籤)
    if (state.searchQuery.trim() !== "") {
        const q = state.searchQuery.toLowerCase().trim();
        result = result.filter(b => {
            const inTitle = b.title.toLowerCase().includes(q);
            const inUrl = b.url.toLowerCase().includes(q);
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

// 收藏卡片生成渲染
function renderBookmarks() {
    const container = document.getElementById("bookmarkContainer");
    const emptyState = document.getElementById("emptyState");
    const items = getFilteredAndSortedBookmarks();

    container.innerHTML = "";

    if (items.length === 0) {
        emptyState.classList.remove("d-none");
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
                <!-- 封面圖區域 -->
                <div class="card-cover-wrapper">
                    <img src="${escapeHtml(coverSrc)}" class="card-cover-img" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.src='${fallbackCover}'">
                    
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
                            <button class="btn btn-outline-success btn-sm action-jump-btn d-flex align-items-center gap-1" onclick="openLegadoReader(0)">
                                <i class="bi bi-book-half"></i> 小說
                            </button>` : ''}
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
}

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

    // 2. 搜尋框輸入
    const searchInput = document.getElementById("searchInput");
    const clearSearchBtn = document.getElementById("clearSearchBtn");
    searchInput.addEventListener("input", e => {
        state.searchQuery = e.target.value;
        if (state.searchQuery.trim() !== "") {
            clearSearchBtn.classList.remove("d-none");
        } else {
            clearSearchBtn.classList.add("d-none");
        }
        renderBookmarks();
    });

    clearSearchBtn.addEventListener("click", () => {
        searchInput.value = "";
        state.searchQuery = "";
        clearSearchBtn.classList.add("d-none");
        renderBookmarks();
        searchInput.focus();
    });

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

    // 4. 視圖切換 (卡片 / 清單)
    const gridBtn = document.getElementById("viewGridBtn");
    const listBtn = document.getElementById("viewListBtn");
    gridBtn.addEventListener("click", () => {
        state.viewMode = "grid";
        gridBtn.classList.add("active");
        listBtn.classList.remove("active");
        document.body.classList.remove("list-view-mode");
        renderBookmarks();
    });
    listBtn.addEventListener("click", () => {
        state.viewMode = "list";
        listBtn.classList.add("active");
        gridBtn.classList.remove("active");
        document.body.classList.add("list-view-mode");
        renderBookmarks();
    });

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

    // 9. 重置範例資料
    document.getElementById("resetDemoBtn").addEventListener("click", e => {
        e.preventDefault();
        if (confirm("確定要重置為預設範例資料嗎？這將覆蓋現有修改。")) {
            state.bookmarks = [...DEFAULT_BOOKMARKS];
            saveToStorage();
            updateUI();
            showToast("已成功重置為預設資料！", "bi-arrow-clockwise text-info");
        }
    });

    // 10. 會員登入 / 註冊切換模擬
    document.getElementById("loginForm").addEventListener("submit", e => {
        e.preventDefault();
        const username = document.getElementById("loginUsername").value.trim();
        if (username) {
            state.currentUser = username;
            saveToStorage();
            updateUI();
            bootstrap.Modal.getInstance(document.getElementById("authModal")).hide();
            showToast(`歡迎回來，${username}！`, "bi-check-circle-fill text-success");
        }
    });

    document.getElementById("registerForm").addEventListener("submit", e => {
        e.preventDefault();
        const username = document.getElementById("regUsername").value.trim();
        if (username) {
            state.currentUser = username;
            // 隨機生成新 Token
            state.apiToken = "usr_tok_" + Math.random().toString(36).substring(2, 12);
            saveToStorage();
            updateUI();
            bootstrap.Modal.getInstance(document.getElementById("authModal")).hide();
            showToast(`帳號 ${username} 註冊並登入成功！`, "bi-check-circle-fill text-success");
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
        state.bookmarks = state.bookmarks.filter(b => b.id !== id);
        saveToStorage();
        updateUI();
        showToast("收藏已成功刪除", "bi-trash3 text-danger");
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
    { id: 'AGE', name: 'AGE動漫', desc: '全網熱門番劇與經典動漫庫' },
    { id: '7sefun', name: '7sefun動漫', desc: '備用高畫質動漫源' }
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

window.openKazumiSourceModal = function(animeTitle = "葬送的芙莉蓮", animeCover = "") {
    if (!animeTitle || animeTitle.trim() === "") animeTitle = "葬送的芙莉蓮";
    kazumiState.title = animeTitle.trim();
    kazumiState.cover = animeCover || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=700&q=80";
    kazumiState.sources = new Map(KAZUMI_SOURCES.map(s => [s.id, { status: 'loading', results: [], expanded: false, episodes: {} }]));

    const titleEl = document.getElementById('kazumiSourceTitle');
    const coverEl = document.getElementById('kazumiSourceCover');
    const summaryEl = document.getElementById('kazumiSourceSummary');
    const kwInput = document.getElementById('kazumiModalKeywordInput');

    if (titleEl) titleEl.textContent = kazumiState.title;
    if (coverEl) coverEl.src = kazumiState.cover;
    if (kwInput) kwInput.value = kazumiState.title;
    if (summaryEl) summaryEl.textContent = `${KAZUMI_SOURCES.length} 個來源 · 正在檢索...`;

    renderSourceList();

    // 同步並發向後端請求各來源
    KAZUMI_SOURCES.forEach(s => fetchRuleSearch(s.id, kazumiState.title));

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
                <small class="text-secondary opacity-75">${escapeHtml(source.desc)}</small>
            </div>
            <div class="d-flex align-items-center gap-2">
                ${badgeHtml}
                ${state.status === 'done' ? `<i class="bi bi-chevron-${state.expanded ? 'up' : 'down'} text-secondary"></i>` : ''}
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

                const itemHeader = document.createElement('div');
                itemHeader.className = 'd-flex align-items-center justify-content-between flex-wrap gap-2 mb-2';
                itemHeader.innerHTML = `
                    <div class="d-flex align-items-center gap-2 text-truncate" style="max-width: 70%;">
                        <span class="badge bg-danger-subtle text-danger px-1">#${rIdx + 1}</span>
                        <span class="fw-semibold text-white small text-truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
                    </div>
                    <button class="btn btn-xs btn-outline-danger" id="epBtn_${source.id}_${rIdx}">
                        <i class="bi bi-list-ul"></i> 取得選集
                    </button>
                `;

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
            return `<span class="badge bg-secondary-subtle text-muted">無符合結果</span>`;
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

    const displayEps = uniqueEpisodes.slice(0, 48);
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
        const moreSpan = document.createElement('span');
        moreSpan.className = 'badge bg-secondary-subtle text-muted align-self-center small';
        moreSpan.textContent = `+ 尚有 ${uniqueEpisodes.length - 48} 集`;
        container.appendChild(moreSpan);
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

            openTheaterWithUrl(animeItem.title, episode.title, data.playerUrl, allEpisodes, episode);
        } else {
            throw new Error(data.error || '解析播放器網址失敗');
        }
    } catch (err) {
        console.error('播放失敗：', err);
        showToast(`解析「${episode.title}」失敗：${err.message}`, "bi-exclamation-octagon text-danger");
    }
}

function openTheaterWithUrl(animeTitle, epTitle, playerUrl, allEpisodes = [], currentEp = null) {
    const modalTitle = document.getElementById("animePlayerTitle");
    if (modalTitle) modalTitle.textContent = `${animeTitle} - ${epTitle}`;

    const video = document.getElementById("kazumiVideoPlayer");
    const iframe = document.getElementById("kazumiIframePlayer");
    const placeholder = document.getElementById("kazumiTheaterPlaceholder");

    if (placeholder) placeholder.style.display = "none";

    // 判斷是否為 direct mp4 / m3u8 還是 web/iframe 解析器
    if (playerUrl.endsWith('.mp4') || playerUrl.endsWith('.m3u8')) {
        if (iframe) { iframe.src = ""; iframe.style.display = "none"; }
        if (video) {
            video.style.display = "block";
            video.src = playerUrl;
            video.currentTime = 0;
            video.play().catch(() => {});
        }
    } else {
        if (video) { video.pause(); video.style.display = "none"; }
        if (iframe) {
            iframe.style.display = "block";
            iframe.src = playerUrl;
        }
    }

    // 注入動漫劇院右側選集抽屜 (進行集數防重保護)
    const listContainer = document.querySelector(".episode-list-container");
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
            btn.className = `btn btn-sm ${isActive ? 'btn-primary active' : 'btn-outline-secondary'} ep-btn text-truncate text-start`;
            btn.style.maxWidth = "100%";
            btn.title = ep.title;
            btn.innerHTML = `<i class="bi bi-play-fill"></i> ${escapeHtml(ep.title)}`;
            btn.onclick = () => {
                playRuleEpisode('', { title: animeTitle }, ep, uniqueEps);
            };
            listContainer.appendChild(btn);
        });
    }

    // 清空彈幕層
    clearInterval(danmakuInterval);
    const overlay = document.getElementById("danmakuOverlay");
    if (overlay) overlay.innerHTML = "";

    const theaterModal = bootstrap.Modal.getOrCreateInstance(document.getElementById("animePlayerModal"));
    theaterModal.show();
}

// 劇院內一鍵搜尋番劇（支援待命畫面與 Header 搜尋）
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

    // 關閉目前劇院視窗，開啟播放來源抽屜
    const theaterModal = bootstrap.Modal.getInstance(document.getElementById('animePlayerModal'));
    if (theaterModal) theaterModal.hide();

    // 開啟播放來源搜尋
    openKazumiSourceModal(term);
};

// 重置動漫劇院為純淨黑底空白待命狀態
window.resetKazumiTheater = function() {
    const video = document.getElementById("kazumiVideoPlayer");
    const iframe = document.getElementById("kazumiIframePlayer");
    const placeholder = document.getElementById("kazumiTheaterPlaceholder");
    const titleEl = document.getElementById("animePlayerTitle");
    const listContainer = document.querySelector(".episode-list-container");

    const standbyInput = document.getElementById("theaterStandbySearchInput");
    const headerInput = document.getElementById("theaterHeaderSearchInput");
    if (standbyInput) standbyInput.value = "";
    if (headerInput) headerInput.value = "";

    if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.style.display = "none";
    }
    if (iframe) {
        iframe.src = "";
        iframe.style.display = "none";
    }
    if (placeholder) {
        placeholder.style.display = "block";
    }
    if (titleEl) {
        titleEl.textContent = "動漫劇院播放器（待命狀態）";
    }
    if (listContainer) {
        listContainer.innerHTML = '<div class="text-secondary small p-3 text-center w-100" id="kazumiEpisodePlaceholder">請先由來源清單選擇集數開播</div>';
    }
};

// --- A. Kazumi 動漫劇院播放器 ---
let danmakuInterval = null;
let danmakuEnabled = true;

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

    document.getElementById("animePlayerTitle").textContent = title;
    const video = document.getElementById("kazumiVideoPlayer");
    const iframe = document.getElementById("kazumiIframePlayer");
    const placeholder = document.getElementById("kazumiTheaterPlaceholder");
    if (placeholder) placeholder.style.display = "none";

    // 辨識是否為 Bilibili 影片
    const biliMatch = src.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/i) || src.match(/(BV[a-zA-Z0-9]{10})/i);
    // 辨識是否為 YouTube 影片
    const ytMatch = src.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

    if (biliMatch) {
        // Bilibili 官方高清內嵌播放器
        const bvid = biliMatch[1];
        video.pause();
        video.style.display = "none";
        iframe.style.display = "block";
        iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=1&high_quality=1&as_wide=1&danmaku=1`;
        showToast("已載入 Bilibili 官方無廣告內嵌播放器！", "bi-play-btn-fill text-danger");

        // 呼叫後端 Kazumi 模組解析真實分P選集與 CID
        fetch(`/api/kazumi/resolve?bvid=${bvid}`)
            .then(r => r.json())
            .then(res => {
                if (res.success && res.data && Array.isArray(res.data.episodes) && res.data.episodes.length > 0) {
                    renderKazumiEpisodes(bvid, res.data.episodes);
                    if (res.data.episodes[0].cid) {
                        startDanmakuStream(title, res.data.episodes[0].cid);
                    }
                }
            })
            .catch(() => {});
    } else if (ytMatch) {
        // YouTube 官方內嵌播放器
        const ytId = ytMatch[1];
        video.pause();
        video.style.display = "none";
        iframe.style.display = "block";
        iframe.src = `https://www.youtube.com/embed/${ytId}?autoplay=1`;
        showToast("已載入 YouTube 官方內嵌劇院！", "bi-youtube text-danger");
    } else {
        // 原生 HTML5 影片 / 代理串流
        iframe.src = "";
        iframe.style.display = "none";
        video.style.display = "block";
        video.src = src;
        video.currentTime = 0;
        video.play().catch(() => {});
    }

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("animePlayerModal"));
    modal.show();

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
        btn.onclick = () => {
            document.querySelectorAll(".ep-btn").forEach(b => {
                b.classList.remove("btn-primary", "active");
                b.classList.add("btn-outline-secondary");
            });
            btn.classList.remove("btn-outline-secondary");
            btn.classList.add("btn-primary", "active");
            
            const iframe = document.getElementById("kazumiIframePlayer");
            iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&page=${ep.page}&high_quality=1&as_wide=1&danmaku=1`;
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
    const video = document.getElementById("kazumiVideoPlayer");
    const iframe = document.getElementById("kazumiIframePlayer");
    video.pause();
    iframe.src = ""; // 停止播放
    clearInterval(danmakuInterval);
    document.getElementById("danmakuOverlay").innerHTML = "";
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

// 彈幕發送與飄字動畫
function createBulletDanmaku(text, color = "#ffffff") {
    if (!danmakuEnabled) return;
    const overlay = document.getElementById("danmakuOverlay");
    if (!overlay) return;

    const bullet = document.createElement("div");
    bullet.className = "danmaku-bullet";
    bullet.textContent = text;
    bullet.style.top = Math.floor(Math.random() * 65 + 10) + "%";
    bullet.style.color = color;

    overlay.appendChild(bullet);
    setTimeout(() => bullet.remove(), 8500);
}

// 串接 Kazumi 後端彈幕流 (僅在取得真實 CID 彈幕時播放，絕不產生任何預設假彈幕)
async function startDanmakuStream(animeTitle, cid = null) {
    clearInterval(danmakuInterval);
    const overlay = document.getElementById("danmakuOverlay");
    if (overlay) overlay.innerHTML = "";

    // 若無真實 CID 則完全不播放預設假彈幕
    if (!cid) return;

    let danmakuQueue = [];
    try {
        const res = await fetch(`/api/kazumi/danmaku?cid=${cid}`);
        if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.danmaku) && data.danmaku.length > 0) {
                danmakuQueue = data.danmaku;
            }
        }
    } catch (e) {
        console.warn('Real danmaku fetch error:', e);
    }

    if (danmakuQueue.length === 0) return;

    let queueIdx = 0;
    danmakuInterval = setInterval(() => {
        if (!danmakuEnabled || danmakuQueue.length === 0) return;
        const item = danmakuQueue[queueIdx % danmakuQueue.length];
        createBulletDanmaku(item.content, item.color || "#ffffff");
        queueIdx++;
        // 播放完畢即停止，不重複洗版
        if (queueIdx >= danmakuQueue.length) {
            clearInterval(danmakuInterval);
        }
    }, 2000);
}

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
            danmakuEnabled = !danmakuEnabled;
            toggleBtn.innerHTML = danmakuEnabled 
                ? `<i class="bi bi-chat-square-dots-fill text-warning"></i> 彈幕: 開` 
                : `<i class="bi bi-chat-square-dots text-muted"></i> 彈幕: 關`;
            const overlay = document.getElementById("danmakuOverlay");
            if (overlay) overlay.style.display = danmakuEnabled ? "block" : "none";
        });
    }
});


// --- B. Tachimanga 條漫閱讀器 ---
let currentMangaZoom = 1.0;
const SAMPLE_MANGA_PAGES = [];

window.openTachimangaReader = function(title = "漫畫閱覽器", pages = SAMPLE_MANGA_PAGES) {
    const titleEl = document.getElementById("mangaModalTitle");
    const indicatorEl = document.getElementById("mangaPageIndicator");
    const wrapper = document.getElementById("mangaPageWrapper");

    if (titleEl) titleEl.textContent = title;
    currentMangaZoom = 1.0;
    if (wrapper) {
        wrapper.innerHTML = "";
        wrapper.style.transform = `scale(${currentMangaZoom})`;
    }

    if (!pages || pages.length === 0) {
        if (indicatorEl) indicatorEl.textContent = "";
        if (wrapper) {
            wrapper.innerHTML = `
                <div class="text-center text-secondary py-5 my-5" id="tachimangaPlaceholder">
                    <i class="bi bi-book fs-1 d-block mb-3 opacity-50"></i>
                    <p class="fs-5 fw-semibold mb-1 text-light">漫畫閱覽器（待命狀態）</p>
                    <span class="small opacity-75">尚未載入漫畫內容，請先選擇作品章節</span>
                </div>
            `;
        }
    } else {
        pages.forEach((src, idx) => {
            const img = document.createElement("img");
            img.className = "manga-page-img";
            img.src = src;
            img.alt = `Page ${idx + 1}`;
            img.setAttribute("referrerpolicy", "no-referrer"); // 繞過多數防盜鏈
            img.loading = "lazy";
            wrapper.appendChild(img);
        });

        if (indicatorEl) indicatorEl.textContent = `第 1 頁 / 共 ${pages.length} 頁`;

        const scrollBox = document.getElementById("mangaScrollContainer");
        if (scrollBox) {
            scrollBox.scrollTop = 0;
            scrollBox.onscroll = () => {
                const pageHeight = 500;
                const currentP = Math.min(pages.length, Math.floor(scrollBox.scrollTop / pageHeight) + 1);
                if (indicatorEl) indicatorEl.textContent = `第 ${currentP} 頁 / 共 ${pages.length} 頁`;
            };
        }
    }

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("mangaReaderModal"));
    modal.show();
};

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


// --- C. Legado 沉浸小說閱讀器 ---
const SAMPLE_NOVEL_CHAPTERS = [];

let currentNovelIndex = 0;
let currentNovelFontSize = 18;

window.openLegadoReader = function(chapIdx = 0) {
    const bookTitleEl = document.getElementById("novelBookTitle");
    const chapTitleEl = document.getElementById("novelChapterTitle");
    const articleBox = document.getElementById("novelArticleContent");

    if (!SAMPLE_NOVEL_CHAPTERS || SAMPLE_NOVEL_CHAPTERS.length === 0) {
        if (bookTitleEl) bookTitleEl.textContent = "沉浸小說閱讀";
        if (chapTitleEl) chapTitleEl.textContent = "";
        if (articleBox) {
            articleBox.innerHTML = `
                <div class="text-center text-secondary py-5 my-5" id="legadoPlaceholder">
                    <i class="bi bi-journal-text fs-1 d-block mb-3 opacity-50"></i>
                    <p class="fs-5 fw-semibold mb-1 text-dark">小說閱讀器（待命狀態）</p>
                    <span class="small opacity-75">尚未載入小說內容，請先選擇章節開始閱讀</span>
                </div>
            `;
        }
        const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("novelReaderModal"));
        modal.show();
        return;
    }

    currentNovelIndex = Math.max(0, Math.min(SAMPLE_NOVEL_CHAPTERS.length - 1, chapIdx));
    const data = SAMPLE_NOVEL_CHAPTERS[currentNovelIndex];

    if (bookTitleEl) bookTitleEl.textContent = data.book || "沉浸小說閱讀";
    if (chapTitleEl) chapTitleEl.textContent = data.chapter || "";

    if (articleBox) {
        articleBox.innerHTML = `
            <h3 class="fw-bold mb-4 pb-3 border-bottom">${escapeHtml(data.chapter)}</h3>
            ${Array.isArray(data.content) ? data.content.map(p => `<p class="mb-4" style="text-indent: 2em;">${escapeHtml(p)}</p>`).join("") : `<p class="mb-4">${escapeHtml(data.content)}</p>`}
        `;
    }

    const bodyWrapper = document.getElementById("novelBodyWrapper");
    if (bodyWrapper) bodyWrapper.scrollTop = 0;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("novelReaderModal"));
    modal.show();
};

window.switchNovelChapter = function(delta) {
    if (!SAMPLE_NOVEL_CHAPTERS || SAMPLE_NOVEL_CHAPTERS.length === 0) {
        showToast("尚未載入小說章節", "bi-info-circle text-info");
        return;
    }
    const nextIdx = currentNovelIndex + delta;
    if (nextIdx < 0) {
        showToast("已經是第一章囉！", "bi-info-circle text-info");
        return;
    }
    if (nextIdx >= SAMPLE_NOVEL_CHAPTERS.length) {
        showToast("已閱讀至最新章節！", "bi-check-all text-success");
        return;
    }
    openLegadoReader(nextIdx);
};

window.setNovelTheme = function(theme) {
    const container = document.getElementById("novelContentContainer");
    container.className = `modal-content border-0 novel-theme-${theme}`;
};

window.adjustNovelFontSize = function(delta) {
    currentNovelFontSize = Math.min(26, Math.max(14, currentNovelFontSize + delta));
    const articleBox = document.getElementById("novelArticleContent");
    articleBox.style.fontSize = currentNovelFontSize + "px";
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
                    <img src="${escapeHtml(cover)}" class="bgm-anime-cover-img" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=700&q=80'">
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
// 8. Bangumi 帳號追番清單一鍵同步核心
// ==========================================
window.triggerBangumiUserSync = async function() {
    const usernameInput = document.getElementById("bgmUsernameInput");
    const syncTypeSelect = document.getElementById("bgmSyncType");
    const alertBox = document.getElementById("bgmSyncResultAlert");
    const syncBtn = document.getElementById("startBgmSyncBtn");

    const username = (usernameInput ? usernameInput.value : "").trim();
    const syncType = syncTypeSelect ? syncTypeSelect.value : "3";

    if (!username) {
        if (alertBox) {
            alertBox.className = "alert alert-warning py-2 small";
            alertBox.textContent = "請輸入 Bangumi 使用者名稱或數字 UID！";
            alertBox.classList.remove("d-none");
        }
        return;
    }

    const typeNames = { "1": "想看", "2": "看過", "3": "在看" };
    const currentTypeName = typeNames[syncType] || "在看";

    // 進入載入狀態與 UI 提示
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span> 連線同步中...`;
    }
    if (alertBox) {
        alertBox.className = "alert alert-info py-2 small";
        alertBox.innerHTML = `<div class="d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm text-primary"></div><span>正在自 Bangumi 取得【${escapeHtml(username)}】的「${currentTypeName}」追番數據...</span></div>`;
        alertBox.classList.remove("d-none");
    }

    try {
        const apiUrl = `https://api.bgm.tv/v0/users/${encodeURIComponent(username)}/collections?subject_type=2&type=${syncType}&limit=30`;
        const res = await fetch(apiUrl, {
            headers: {
                "Accept": "application/json"
            }
        });

        if (!res.ok) {
            if (res.status === 404) {
                throw new Error(`找不到使用者【${username}】，請檢查使用者名稱或數字 UID 是否正確。`);
            }
            throw new Error(`API 請求失敗 (HTTP ${res.status})`);
        }

        const data = await res.json();
        const items = data.data || [];

        if (items.length === 0) {
            if (alertBox) {
                alertBox.className = "alert alert-warning py-2 small";
                alertBox.textContent = `使用者【${username}】目前沒有「${currentTypeName}」的動畫記錄。`;
            }
            return;
        }

        let addedCount = 0;
        let updatedCount = 0;

        items.forEach(item => {
            const subject = item.subject || {};
            const subjectId = item.subject_id || subject.id;
            const title = subject.name_cn || subject.name || `Bangumi 動漫 #${subjectId}`;
            const bgmUrl = `https://bgm.tv/subject/${subjectId}`;
            let cover = subject.images?.large || subject.images?.common || subject.images?.medium || subject.images?.small || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1000&q=80";
            cover = cover.replace(/^http:\/\//i, "https://");

            const currentEp = item.ep_status || 0;
            const totalEps = subject.eps || "?";
            const scoreStr = subject.score ? `⭐ 評分 ${subject.score}` : "";
            const desc = `Bangumi 追番進度：[${currentEp}/${totalEps} 集] ${scoreStr} · ${subject.short_summary || ""}`.trim();

            // 檢查圖書館中是否已存在同一個番劇 (以網址或 ID 比對)
            const existingIdx = state.bookmarks.findIndex(b => b.url === bgmUrl || (b.title === title && (b.category === "anime" || b.category === "resource")));

            if (existingIdx !== -1) {
                // 更新進度與封面
                state.bookmarks[existingIdx].cover = cover;
                state.bookmarks[existingIdx].desc = desc;
                state.bookmarks[existingIdx].category = "anime";
                if (!state.bookmarks[existingIdx].tags.includes(currentTypeName)) {
                    state.bookmarks[existingIdx].tags.push(currentTypeName);
                }
                if (!state.bookmarks[existingIdx].tags.includes("動畫")) {
                    state.bookmarks[existingIdx].tags.push("動畫");
                }
                updatedCount++;
            } else {
                const newBookmark = {
                    id: "bm_bgm_" + subjectId + "_" + Date.now(),
                    title: title,
                    url: bgmUrl,
                    category: "anime",
                    tags: ["Bangumi同步", currentTypeName, "動畫"],
                    cover: cover,
                    desc: desc,
                    pinned: false,
                    clicks: 0,
                    createdAt: new Date().toISOString()
                };
                state.bookmarks.unshift(newBookmark);
                addedCount++;
            }
        });

        saveToStorage();
        updateUI();

        if (alertBox) {
            alertBox.className = "alert alert-success py-2 small";
            alertBox.innerHTML = `🎉 同步成功！新增 <b>${addedCount}</b> 部、更新 <b>${updatedCount}</b> 部「${currentTypeName}」動畫至圖書館。`;
        }

        showToast(`🎉 成功自 Bangumi 同步 ${addedCount + updatedCount} 部動畫！`, "bi-check-circle-fill text-success");

        // 1.6 秒後自動關閉 Modal
        setTimeout(() => {
            const modalEl = document.getElementById("bangumiSyncModal");
            if (modalEl) {
                const modal = bootstrap.Modal.getInstance(modalEl);
                if (modal) modal.hide();
            }
            if (alertBox) alertBox.classList.add("d-none");
        }, 1600);

    } catch (err) {
        console.error("Bangumi 追番同步失敗", err);
        if (alertBox) {
            alertBox.className = "alert alert-danger py-2 small";
            alertBox.textContent = `❌ 同步失敗：${err.message || "網路連線異常，請稍後重試"}`;
        }
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.innerHTML = `<i class="bi bi-cloud-arrow-down-fill"></i> 開始同步匯入`;
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
    state.bookmarks = state.bookmarks.filter(b => !state.selectedBookmarkIds.has(b.id));
    state.selectedBookmarkIds.clear();
    saveToStorage();
    updateUI();
    updateBatchUI();
    showToast(`🗑️ 已成功批量刪除 ${count} 個書籤！`, "bi-trash3-fill text-danger");
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
                            <img src="${escapeHtml(cover)}" class="bgm-anime-cover-img" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=600&q=80'">
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
    video.pause();
    video.style.display = "none";
    iframe.style.display = "block";
    iframe.src = "";

    const modal = new bootstrap.Modal(document.getElementById("animePlayerModal"));
    modal.show();

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
            const iframe = document.getElementById("kazumiIframePlayer");
            iframe.src = data.playerUrl;
            showToast(`已載入 ${epTitle}，即刻開播！`, "bi-check-circle-fill text-success");
        } else {
            showToast("此集暫無播放器資源", "bi-exclamation-triangle text-warning");
        }
    } catch (e) {
        showToast("載入播放器失敗", "bi-x-circle text-danger");
    }
}

// 若在 ACG 頁面，綁定 Enter 鍵快速搜尋 (保持初始乾淨空白待命)
document.addEventListener("DOMContentLoaded", () => {
    const searchInput = document.getElementById("kazumiSearchInput");
    if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") searchKazumiAnime();
        });
    }
});

// 啟動應用
document.addEventListener("DOMContentLoaded", initApp);
