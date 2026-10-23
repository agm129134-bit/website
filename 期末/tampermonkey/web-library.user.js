// ==UserScript==
// @name         網頁圖書館快速收藏助手 (Web Library Collector)
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  完美相容 YouTube (Trusted Types)、Bangumi (防放大)、支援自由拖曳移動位置、開關懸浮球與 Alt + B 快捷鍵收藏！
// @author       Web System Design Student
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @include      *
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function() {
    'use strict';

    // 1. 頂層視窗檢查：防止被廣告或播放器 iframe 劫持
    if (window.top !== window.self) {
        return;
    }

    // 讀取設定與儲存的位置
    const config = {
        get serverUrl() { return GM_getValue("wl_server_url", "http://localhost:8000/api/user/bookmarks"); },
        set serverUrl(v) { GM_setValue("wl_server_url", v); },
        get apiToken() { return GM_getValue("wl_api_token", "usr_tok_8f92ab3c71e041d8b991a"); },
        set apiToken(v) { GM_setValue("wl_api_token", v); },
        get showFab() { return GM_getValue("wl_show_fab", true); },
        set showFab(v) { GM_setValue("wl_show_fab", v); },
        get fabPos() { return GM_getValue("wl_fab_pos", null); },
        set fabPos(v) { GM_setValue("wl_fab_pos", v); }
    };

    // 2. 自動提取網頁資訊 (YouTube / B站 / GitHub / 動漫站)
    function detectPageMetadata() {
        const url = window.location.href;
        const host = window.location.hostname.toLowerCase();
        let title = document.title || "";
        let category = "web";
        let defaultTags = [];
        let coverUrl = "";

        const ogImage = document.querySelector('meta[property="og:image"]')?.content ||
                        document.querySelector('meta[name="twitter:image"]')?.content ||
                        document.querySelector('meta[itemprop="image"]')?.content;
        if (ogImage) coverUrl = ogImage;

        const ogDesc = document.querySelector('meta[property="og:description"]')?.content ||
                       document.querySelector('meta[name="description"]')?.content || "";

        if (host.includes("youtube.com") || host.includes("youtu.be")) {
            category = "video";
            defaultTags = ["YouTube", "影音串流"];
            title = title.replace(/- YouTube$/i, "").trim();
            const ytMatch = url.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (ytMatch && ytMatch[1]) {
                coverUrl = `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
            }
        } else if (host.includes("bilibili.com")) {
            category = "video";
            defaultTags = ["Bilibili", "B站", "影音影片"];
            title = title.replace(/_哔哩哔哩_bilibili$/i, "").trim();
            if (!coverUrl) {
                const videoEl = document.querySelector("video");
                if (videoEl && videoEl.poster) coverUrl = videoEl.poster;
            }
        } else if (host.includes("github.com")) {
            category = "web";
            defaultTags = ["GitHub", "開源項目"];
            title = title.replace(/GitHub - /i, "").trim();
            const parts = window.location.pathname.split("/").filter(Boolean);
            if (parts.length >= 2 && !coverUrl) {
                coverUrl = `https://opengraph.githubassets.com/1/${parts[0]}/${parts[1]}`;
            }
        } else if (host.includes("ani.gamer.com.tw") || host.includes("bangumi.tv") || host.includes("copymanga") || host.includes("dm5.com")) {
            category = "resource";
            defaultTags = ["動漫", "漫畫", "ACG資源"];
            const posterImg = document.querySelector(".anime_cover img, .coverList img, .data .poster img, .pic img");
            if (posterImg && posterImg.src) coverUrl = posterImg.src;
        }

        if (coverUrl && !coverUrl.startsWith("http")) {
            try { coverUrl = new URL(coverUrl, window.location.origin).href; } catch(e){}
        }

        return { url, title, category, defaultTags, coverUrl, desc: ogDesc };
    }

    // 3. 【核心修復】建立支援「自由拖曳、尺寸鎖定（防 Bangumi 放大）、顯示開關」的 FAB 懸浮球
    let fabElement = null;

    function createDraggableFAB() {
        if (document.getElementById("wl-collector-fab")) {
            fabElement = document.getElementById("wl-collector-fab");
            applyFabVisibility();
            return;
        }

        const fab = document.createElement("div");
        fab.id = "wl-collector-fab";
        fab.setAttribute("title", "按住可隨意拖曳位置；點擊或按 Alt + B 開啟收藏");

        // 鎖定固定尺寸 48px，防 Bangumi 等網站 zoom 放大
        fab.style.cssText = `
            position: fixed !important;
            width: 48px !important;
            height: 48px !important;
            min-width: 48px !important;
            max-width: 48px !important;
            min-height: 48px !important;
            max-height: 48px !important;
            border-radius: 50% !important;
            background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
            box-shadow: 0 4px 16px rgba(79, 70, 229, 0.4) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: grab !important;
            z-index: 2147483647 !important;
            user-select: none !important;
            border: 2px solid rgba(255, 255, 255, 0.85) !important;
            box-sizing: border-box !important;
            opacity: 0.95 !important;
            zoom: 1 !important;
            transform-origin: center center !important;
            font-size: 14px !important;
        `;

        // 讀取歷史儲存座標或預設右下角
        const savedPos = config.fabPos;
        if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
            // 邊界檢查避免拖出螢幕外
            const maxL = Math.max(10, window.innerWidth - 60);
            const maxT = Math.max(10, window.innerHeight - 60);
            const curL = Math.min(maxL, Math.max(10, savedPos.left));
            const curT = Math.min(maxT, Math.max(10, savedPos.top));
            fab.style.left = curL + "px";
            fab.style.top = curT + "px";
            fab.style.bottom = "auto";
            fab.style.right = "auto";
        } else {
            fab.style.bottom = "30px";
            fab.style.right = "30px";
        }

        // 原生 SVG (避開 Trusted Types)
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "22");
        svg.setAttribute("height", "22");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "#ffffff");
        svg.setAttribute("stroke-width", "2.2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.style.pointerEvents = "none";

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z");
        svg.appendChild(path);
        fab.appendChild(svg);

        // --- 自由拖曳邏輯 (Drag & Drop) ---
        let isDragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0;
        let initialL = 0, initialT = 0;

        fab.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // 僅限左鍵
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = fab.getBoundingClientRect();
            initialL = rect.left;
            initialT = rect.top;

            fab.style.cursor = "grabbing";
            fab.style.transition = "none";

            const onMouseMove = (moveEvent) => {
                if (!isDragging) return;
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;

                if (Math.hypot(dx, dy) > 5) {
                    hasMoved = true;
                }

                // 計算新座標並做視窗邊界限制
                let newL = initialL + dx;
                let newT = initialT + dy;
                const maxL = window.innerWidth - fab.offsetWidth - 8;
                const maxT = window.innerHeight - fab.offsetHeight - 8;
                newL = Math.max(8, Math.min(maxL, newL));
                newT = Math.max(8, Math.min(maxT, newT));

                fab.style.left = newL + "px";
                fab.style.top = newT + "px";
                fab.style.bottom = "auto";
                fab.style.right = "auto";
            };

            const onMouseUp = () => {
                isDragging = false;
                fab.style.cursor = "grab";
                fab.style.transition = "all 0.2s ease";
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);

                if (hasMoved) {
                    // 保存新位置
                    const rect = fab.getBoundingClientRect();
                    config.fabPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
                }
            };

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });

        // 點擊事件：只有在「未拖曳」時才開啟彈窗
        fab.addEventListener("click", (e) => {
            if (hasMoved) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            toggleCollectorModal();
        });

        fabElement = fab;
        applyFabVisibility();

        const rootContainer = document.documentElement || document.body;
        if (rootContainer) {
            rootContainer.appendChild(fab);
        }
    }

    function applyFabVisibility() {
        if (!fabElement) return;
        if (config.showFab) {
            fabElement.style.setProperty("display", "flex", "important");
        } else {
            fabElement.style.setProperty("display", "none", "important");
        }
    }

    // 4. 原生 DOM 建立 Modal 視窗 (相容 YouTube Trusted Types)
    function createSafeModal() {
        if (document.getElementById("wl-collector-modal")) return;

        const overlay = document.createElement("div");
        overlay.id = "wl-collector-modal";
        overlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background-color: rgba(15, 23, 42, 0.6) !important;
            backdrop-filter: blur(6px) !important;
            z-index: 2147483647 !important;
            display: none !important;
            align-items: center !important;
            justify-content: center !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
            box-sizing: border-box !important;
            zoom: 1 !important;
        `;

        const card = document.createElement("div");
        card.id = "wl-modal-card";
        card.style.cssText = `
            background: #ffffff !important;
            width: 460px !important;
            max-width: 92vw !important;
            border-radius: 14px !important;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35) !important;
            overflow: hidden !important;
            border: 1px solid #e2e8f0 !important;
            box-sizing: border-box !important;
            color: #0f172a !important;
            text-align: left !important;
            line-height: 1.5 !important;
        `;

        // --- 頂部 Header ---
        const header = document.createElement("div");
        header.style.cssText = "background: #0f172a !important; color: white !important; padding: 14px 18px !important; display: flex !important; align-items: center !important; justify-content: space-between !important;";
        
        const titleSpan = document.createElement("span");
        titleSpan.textContent = "📚 收藏至 Web Library";
        titleSpan.style.cssText = "font-weight: 600; font-size: 15px;";
        header.appendChild(titleSpan);

        const btnGroup = document.createElement("div");
        btnGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";

        const setBtn = document.createElement("button");
        setBtn.id = "wl-settings-toggle-btn";
        setBtn.textContent = "⚙️";
        setBtn.title = "設定 API Token 與懸浮球開關";
        setBtn.style.cssText = "background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 2px 4px;";
        btnGroup.appendChild(setBtn);

        const closeBtn = document.createElement("button");
        closeBtn.id = "wl-close-btn";
        closeBtn.textContent = "✕";
        closeBtn.style.cssText = "background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;";
        btnGroup.appendChild(closeBtn);

        header.appendChild(btnGroup);
        card.appendChild(header);

        // --- 抽屜 Drawer (含 API Token 與懸浮按鈕開關) ---
        const drawer = document.createElement("div");
        drawer.id = "wl-settings-drawer";
        drawer.style.cssText = "display: none; background: #f8fafc; padding: 12px 18px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #475569;";

        // 懸浮球顯示開關 Checkbox
        const showFabWrap = document.createElement("div");
        showFabWrap.style.cssText = "margin-bottom: 10px; display: flex; align-items: center; gap: 6px;";
        const showFabCheckbox = document.createElement("input");
        showFabCheckbox.type = "checkbox";
        showFabCheckbox.id = "wl-cfg-show-fab";
        showFabCheckbox.checked = config.showFab;
        const showFabLabel = document.createElement("label");
        showFabLabel.htmlFor = "wl-cfg-show-fab";
        showFabLabel.textContent = "顯示畫面懸浮按鈕 (若關閉，仍可隨時按 Alt + B 收藏)";
        showFabLabel.style.cssText = "font-weight: 600; color: #0f172a; cursor: pointer;";
        showFabWrap.appendChild(showFabCheckbox);
        showFabWrap.appendChild(showFabLabel);
        drawer.appendChild(showFabWrap);

        // 重置位置按鈕
        const resetPosBtn = document.createElement("button");
        resetPosBtn.textContent = "📍 重設懸浮按鈕位置至右下角";
        resetPosBtn.style.cssText = "margin-bottom: 10px; display: inline-block; padding: 3px 8px; font-size: 11px; background: #e2e8f0; border: none; border-radius: 4px; cursor: pointer; color: #334155;";
        resetPosBtn.addEventListener("click", () => {
            config.fabPos = null;
            if (fabElement) {
                fabElement.style.left = "auto";
                fabElement.style.top = "auto";
                fabElement.style.bottom = "30px";
                fabElement.style.right = "30px";
            }
            showNotice("已重置懸浮按鈕回預設右下角！");
        });
        drawer.appendChild(resetPosBtn);

        const tokLabel = document.createElement("label");
        tokLabel.textContent = "個人 API Token (權杖)";
        tokLabel.style.cssText = "display: block; font-weight: 600; margin-bottom: 4px;";
        drawer.appendChild(tokLabel);

        const tokInput = document.createElement("input");
        tokInput.id = "wl-cfg-token";
        tokInput.value = config.apiToken;
        tokInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-family: monospace; font-size: 12px; margin-bottom: 8px;";
        drawer.appendChild(tokInput);

        const urlLabel = document.createElement("label");
        urlLabel.textContent = "伺服器 API 位址";
        urlLabel.style.cssText = "display: block; font-weight: 600; margin-bottom: 4px;";
        drawer.appendChild(urlLabel);

        const urlInput = document.createElement("input");
        urlInput.id = "wl-cfg-url";
        urlInput.value = config.serverUrl;
        urlInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; margin-bottom: 8px;";
        drawer.appendChild(urlInput);

        const drawerBottom = document.createElement("div");
        drawerBottom.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
        const saveCfgBtn = document.createElement("button");
        saveCfgBtn.id = "wl-save-cfg-btn";
        saveCfgBtn.textContent = "儲存所有設定";
        saveCfgBtn.style.cssText = "padding: 5px 14px; background: #0f172a; color: white; border: none; border-radius: 4px; font-size: 12px; cursor: pointer;";
        const tipSpan = document.createElement("span");
        tipSpan.id = "wl-cfg-tip";
        tipSpan.textContent = "已成功儲存！";
        tipSpan.style.cssText = "color: #16a34a; font-weight: 600; display: none;";
        drawerBottom.appendChild(saveCfgBtn);
        drawerBottom.appendChild(tipSpan);
        drawer.appendChild(drawerBottom);
        card.appendChild(drawer);

        // --- 表單本體 Form Body ---
        const body = document.createElement("div");
        body.style.cssText = "padding: 18px !important; box-sizing: border-box !important;";

        // 封面預覽
        const coverBox = document.createElement("div");
        coverBox.id = "wl-cover-preview-box";
        coverBox.style.cssText = "margin-bottom: 12px; display: none;";
        const cLabel = document.createElement("label");
        cLabel.textContent = "已自動偵測封面圖：";
        cLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #64748b; margin-bottom: 4px;";
        coverBox.appendChild(cLabel);
        const imgWrap = document.createElement("div");
        imgWrap.style.cssText = "width: 100%; height: 120px; background: #f1f5f9; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;";
        const previewImg = document.createElement("img");
        previewImg.id = "wl-img-preview";
        previewImg.style.cssText = "width: 100%; height: 100%; object-fit: cover;";
        imgWrap.appendChild(previewImg);
        coverBox.appendChild(imgWrap);
        body.appendChild(coverBox);

        // 標題
        const tLabel = document.createElement("label");
        tLabel.textContent = "網頁標題";
        tLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";
        body.appendChild(tLabel);
        const titleInput = document.createElement("input");
        titleInput.id = "wl-input-title";
        titleInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; color: #0f172a; margin-bottom: 10px;";
        body.appendChild(titleInput);

        // 分類與標籤 (Flex)
        const row = document.createElement("div");
        row.style.cssText = "display: flex; gap: 10px; margin-bottom: 10px;";
        
        const col1 = document.createElement("div");
        col1.style.cssText = "flex: 1;";
        const catLabel = document.createElement("label");
        catLabel.textContent = "分類";
        catLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";
        col1.appendChild(catLabel);
        const catSelect = document.createElement("select");
        catSelect.id = "wl-input-category";
        catSelect.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; background: white; color: #0f172a;";
        [
            { val: "web", text: "💻 一般網頁" },
            { val: "video", text: "🎬 影片影音" },
            { val: "resource", text: "📦 動漫資源" }
        ].forEach(opt => {
            const o = document.createElement("option");
            o.value = opt.val;
            o.textContent = opt.text;
            catSelect.appendChild(o);
        });
        col1.appendChild(catSelect);
        row.appendChild(col1);

        const col2 = document.createElement("div");
        col2.style.cssText = "flex: 1.2;";
        const tagLabel = document.createElement("label");
        tagLabel.textContent = "標籤 (逗號分隔)";
        tagLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";
        col2.appendChild(tagLabel);
        const tagInput = document.createElement("input");
        tagInput.id = "wl-input-tags";
        tagInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; color: #0f172a;";
        col2.appendChild(tagInput);
        row.appendChild(col2);
        body.appendChild(row);

        // 封面 URL
        const covLabel = document.createElement("label");
        covLabel.textContent = "封面圖網址 (URL)";
        covLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";
        body.appendChild(covLabel);
        const covInput = document.createElement("input");
        covInput.id = "wl-input-cover";
        covInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; color: #64748b; margin-bottom: 10px;";
        body.appendChild(covInput);

        // 簡介
        const dLabel = document.createElement("label");
        dLabel.textContent = "筆記描述 (選填)";
        dLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";
        body.appendChild(dLabel);
        const descArea = document.createElement("textarea");
        descArea.id = "wl-input-desc";
        descArea.placeholder = "輸入備註或重點...";
        descArea.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; height: 42px; resize: none; color: #0f172a; margin-bottom: 16px;";
        body.appendChild(descArea);

        // 底部按鈕
        const foot = document.createElement("div");
        foot.style.cssText = "display: flex; justify-content: flex-end; gap: 8px;";
        
        const cancelBtn = document.createElement("button");
        cancelBtn.id = "wl-cancel-btn";
        cancelBtn.textContent = "取消";
        cancelBtn.style.cssText = "padding: 7px 16px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #475569; cursor: pointer; font-size: 13px;";
        
        const submitBtn = document.createElement("button");
        submitBtn.id = "wl-submit-btn";
        submitBtn.textContent = "確認收藏";
        submitBtn.style.cssText = "padding: 7px 20px; border: none; border-radius: 6px; background: #4f46e5; color: white; cursor: pointer; font-weight: 600; font-size: 13px;";
        
        foot.appendChild(cancelBtn);
        foot.appendChild(submitBtn);
        body.appendChild(foot);

        card.appendChild(body);
        overlay.appendChild(card);

        const rootContainer = document.documentElement || document.body;
        rootContainer.appendChild(overlay);

        // 事件綁定
        closeBtn.addEventListener("click", () => overlay.style.setProperty("display", "none", "important"));
        cancelBtn.addEventListener("click", () => overlay.style.setProperty("display", "none", "important"));
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.style.setProperty("display", "none", "important");
        });

        setBtn.addEventListener("click", () => {
            drawer.style.display = drawer.style.display === "none" ? "block" : "none";
        });

        saveCfgBtn.addEventListener("click", () => {
            config.apiToken = tokInput.value.trim();
            config.serverUrl = urlInput.value.trim();
            config.showFab = showFabCheckbox.checked;
            applyFabVisibility();
            tipSpan.style.display = "inline";
            setTimeout(() => tipSpan.style.display = "none", 2000);
        });

        covInput.addEventListener("input", (e) => {
            const val = e.target.value.trim();
            if (val) {
                previewImg.src = val;
                coverBox.style.display = "block";
            } else {
                coverBox.style.display = "none";
            }
        });

        submitBtn.addEventListener("click", () => {
            submitBookmark({
                title: titleInput.value.trim(),
                url: window.location.href,
                category: catSelect.value,
                tags: tagInput.value.split(/[,，\s]+/).filter(Boolean),
                cover: covInput.value.trim(),
                desc: descArea.value.trim()
            });
        });
    }

    // 5. 開啟 / 關閉對話框
    function toggleCollectorModal() {
        createSafeModal();
        const modal = document.getElementById("wl-collector-modal");
        const isHidden = modal.style.display === "none" || !modal.style.display;

        if (isHidden) {
            const meta = detectPageMetadata();
            document.getElementById("wl-input-title").value = meta.title;
            document.getElementById("wl-input-category").value = meta.category;
            document.getElementById("wl-input-tags").value = meta.defaultTags.join(", ");
            document.getElementById("wl-input-cover").value = meta.coverUrl;
            document.getElementById("wl-input-desc").value = meta.desc;

            const pbox = document.getElementById("wl-cover-preview-box");
            if (meta.coverUrl) {
                document.getElementById("wl-img-preview").src = meta.coverUrl;
                pbox.style.display = "block";
            } else {
                pbox.style.display = "none";
            }

            modal.style.setProperty("display", "flex", "important");
        } else {
            modal.style.setProperty("display", "none", "important");
        }
    }

    // 6. 送出資料 (具備 先 GET 現有書籤合併 + POST 雙重兼容與 8000/8080 自動切換)
    function submitBookmark(payload) {
        const btn = document.getElementById("wl-submit-btn");
        btn.disabled = true;
        btn.textContent = "傳送中...";

        const trySend = (targetUrl, isRetry = false) => {
            // 先嘗試拉取現有書籤進行合併
            GM_xmlhttpRequest({
                method: "GET",
                url: targetUrl,
                headers: { "Authorization": `Bearer ${config.apiToken}` },
                timeout: 2500,
                onload: function(getRes) {
                    let existing = [];
                    let username = 'default';
                    try {
                        const json = JSON.parse(getRes.responseText);
                        if (Array.isArray(json.bookmarks)) existing = json.bookmarks;
                        if (json.user) username = json.user;
                    } catch (e) {}

                    // 去除舊的相同 URL 並在頭部插入最新書籤
                    const filtered = existing.filter(b => b.url !== payload.url);
                    const merged = [payload, ...filtered];

                    const postBody = {
                        user: username,
                        bookmark: payload,
                        bookmarks: merged
                    };

                    GM_xmlhttpRequest({
                        method: "POST",
                        url: targetUrl,
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${config.apiToken}`
                        },
                        data: JSON.stringify(postBody),
                        timeout: 3000,
                        onload: function(res) {
                            if (res.status >= 200 && res.status < 300) {
                                btn.disabled = false;
                                btn.textContent = "確認收藏";
                                showNotice("🎉 成功收藏至 Web Library！");
                                document.getElementById("wl-collector-modal").style.setProperty("display", "none", "important");
                            } else if (!isRetry) {
                                const altUrl = targetUrl.includes("8000") 
                                    ? targetUrl.replace("8000", "8080") 
                                    : targetUrl.replace("8080", "8000");
                                trySend(altUrl, true);
                            } else {
                                handleLocalFallback(payload);
                            }
                        },
                        ontimeout: () => {
                            if (!isRetry) {
                                const altUrl = targetUrl.includes("8000") ? targetUrl.replace("8000", "8080") : targetUrl.replace("8080", "8000");
                                trySend(altUrl, true);
                            } else {
                                handleLocalFallback(payload);
                            }
                        },
                        onerror: () => {
                            if (!isRetry) {
                                const altUrl = targetUrl.includes("8000") ? targetUrl.replace("8000", "8080") : targetUrl.replace("8080", "8000");
                                trySend(altUrl, true);
                            } else {
                                handleLocalFallback(payload);
                            }
                        }
                    });
                },
                onerror: () => {
                    directPost(targetUrl, isRetry);
                },
                ontimeout: () => {
                    directPost(targetUrl, isRetry);
                }
            });
        };

        const directPost = (targetUrl, isRetry) => {
            const fallbackBody = { bookmark: payload, bookmarks: [payload] };
            GM_xmlhttpRequest({
                method: "POST",
                url: targetUrl,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${config.apiToken}`
                },
                data: JSON.stringify(fallbackBody),
                timeout: 3000,
                onload: function(res) {
                    if (res.status >= 200 && res.status < 300) {
                        btn.disabled = false;
                        btn.textContent = "確認收藏";
                        showNotice("🎉 成功收藏至 Web Library！");
                        document.getElementById("wl-collector-modal").style.setProperty("display", "none", "important");
                    } else if (!isRetry) {
                        const altUrl = targetUrl.includes("8000") ? targetUrl.replace("8000", "8080") : targetUrl.replace("8080", "8000");
                        trySend(altUrl, true);
                    } else {
                        handleLocalFallback(payload);
                    }
                },
                onerror: () => handleLocalFallback(payload),
                ontimeout: () => handleLocalFallback(payload)
            });
        };

        trySend(config.serverUrl);
    }

    function handleLocalFallback(payload) {
        const btn = document.getElementById("wl-submit-btn");
        btn.disabled = false;
        btn.textContent = "確認收藏";

        navigator.clipboard.writeText(JSON.stringify(payload));
        showNotice("✨ 伺服器未開啟，收藏已複製！可回圖書館貼上新增。");
        document.getElementById("wl-collector-modal").style.setProperty("display", "none", "important");
    }

    function showNotice(text) {
        const n = document.createElement("div");
        n.textContent = text;
        n.style.cssText = `
            position: fixed !important;
            bottom: 90px !important;
            right: 30px !important;
            background: #0f172a !important;
            color: #ffffff !important;
            padding: 10px 18px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            box-shadow: 0 8px 24px rgba(0,0,0,0.3) !important;
            z-index: 2147483647 !important;
            user-select: none !important;
            zoom: 1 !important;
        `;
        (document.documentElement || document.body).appendChild(n);
        setTimeout(() => n.remove(), 4000);
    }

    // 7. 最高捕獲優先級快捷鍵監聽
    window.addEventListener("keydown", (e) => {
        if (e.altKey && (e.key === "b" || e.key === "B" || e.code === "KeyB")) {
            e.preventDefault();
            e.stopPropagation();
            toggleCollectorModal();
        }
    }, true);

    // 8. 註冊 Tampermonkey 快捷指令選單
    if (typeof GM_registerMenuCommand !== "undefined") {
        GM_registerMenuCommand("快速開啟收藏對話框 (Alt+B)", toggleCollectorModal);
        GM_registerMenuCommand("切換懸浮球顯示 / 隱藏", () => {
            config.showFab = !config.showFab;
            applyFabVisibility();
            showNotice(config.showFab ? "已開啟懸浮球顯示！" : "已隱藏懸浮球（仍可按 Alt+B 呼叫）");
        });
    }

    // 9. 掛載懸浮球
    function setupTrigger() {
        createDraggableFAB();
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        setupTrigger();
    } else {
        document.addEventListener("DOMContentLoaded", setupTrigger);
    }

    window.addEventListener("yt-navigate-finish", setupTrigger);
    window.addEventListener("popstate", setupTrigger);
    setInterval(setupTrigger, 2500);

})();
