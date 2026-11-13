// ==UserScript==

// @name         網頁圖書館快速收藏助手 (Web Library Collector & Theater Bridge)

// @namespace    http://tampermonkey.net/

// @version      1.8.0

// @description  完美相容 YouTube、Bangumi、動漫劇院全域影片/彈幕雙向秒級同步橋樑 (解決跨域 iframe 暫停/跳轉割裂)、自由拖曳移動位置、開關懸浮球與 Alt + B 快捷鍵收藏！Alt + N 開啟快捷記事本 (可附畫面截圖) 一鍵存進圖書館。

// @author       Web System Design Student

// @match        http://*/*

// @match        https://*/*

// @match        file:///*

// @include      *

// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js

// @run-at       document-idle

// @grant        GM_xmlhttpRequest

// @grant        GM_setValue

// @grant        GM_getValue

// @grant        GM_deleteValue

// @grant        GM_registerMenuCommand

// @connect      localhost

// @connect      127.0.0.1

// ==/UserScript==



/*
 * ======================================================================
 * 上方 ==UserScript== 中繼資料區塊各項設定說明 (此區塊內不能插入文字，所以寫在這裡)
 * ----------------------------------------------------------------------
 * @name        腳本在 Tampermonkey 管理頁面顯示的名稱。
 * @namespace   命名空間，與 @name 合起來用來辨識「這是哪一支腳本」，避免和別人的同名腳本衝突。
 * @version     版本號。Tampermonkey 依此判斷有沒有新版可更新 (這裡不要隨意改動)。
 * @description 腳本簡介，顯示在管理頁面。
 * @author      作者名稱。
 * @match       只在符合這些網址樣式的頁面執行：http://、https://、本機 file:/// 檔案。
 * @include     舊式寫法的網址樣式，「*」代表所有網址 (和上面 @match 一起讓腳本幾乎在每個網頁都跑)。
 * @require     腳本執行前先載入外部函式庫；這裡載入 html2canvas，用來把網頁畫面截成圖片 (記事本截圖功能用)。
 * @run-at      document-idle：等網頁大致載入完成、閒下來才執行，避免拖慢頁面或抓不到元素。
 * @grant       申請使用 Tampermonkey 提供的特權 API (沒申請就不能用)：
 *   GM_xmlhttpRequest      可「跨網域」發送 HTTP 請求。一般網頁的 fetch 會被 CORS 擋住，
 *                          這個 API 由擴充功能代送，才能從 youtube.com 等網站傳資料到 localhost 的圖書館後端。
 *   GM_setValue / GM_getValue / GM_deleteValue
 *                          把設定存在 Tampermonkey 自己的儲存空間 (跨網站共用，和各網站的 localStorage 無關)，
 *                          用來記住伺服器網址、懸浮球位置與是否顯示、記事本草稿。
 *   GM_registerMenuCommand 在 Tampermonkey 圖示的選單裡新增可點選的指令。
 * @connect     白名單：GM_xmlhttpRequest 只允許連到這些主機 (localhost、127.0.0.1，即本機的圖書館伺服器)。
 *              沒列在這裡的網域，Tampermonkey 會跳出詢問或直接拒絕，是一道安全防護。
 * ======================================================================
 */
(function() {

    'use strict';



    /*
     * 【iframe 橋樑說明】
     * 腳本設定成在「所有網頁」執行，包含網頁裡嵌的 iframe (子視窗)。
     * 動漫劇院頁面會把第三方播放器用 iframe 嵌進來，因為跨網域，母頁面無法直接操作裡面的 <video>。
     * 所以：如果目前程式跑在 iframe 裡 (window.top !== window.self)，就只啟動「橋樑」，
     * 用 postMessage 跟母頁面互相傳話 (回報播放狀態、接收暫停/跳轉指令)，然後 return 結束，
     * 不再往下建立收藏懸浮球 (避免每個 iframe 都出現一顆球)。
     * 只有最上層的主頁面 (window.top) 才會執行後面的收藏與記事本功能。
     */
    // 0. 動漫劇院 iframe 內部播放器雙向同步橋樑 (Bi-directional Video Bridge)

    // 徹底解決任何第三方跨域播放器 (ArtPlayer, DPlayer, Bilibili, AGE, 7sefun) 與母網頁彈幕/時間軸割裂問題

    if (window.top !== window.self) {

        initIframePlaybackBridge();

        return;

    }



    /**
     * 啟動 iframe 內的播放器橋樑。
     * 觸發時機：腳本在 iframe 內載入時，由上方判斷式呼叫一次。
     * 做的事：找到 iframe 內的 <video>，監聽播放事件回報給母頁面，並接收母頁面的控制指令。
     * 沒有參數、沒有回傳值。
     */
    function initIframePlaybackBridge() {

        let video = null;

        let lastReportedTime = -1;

        let isSeekingLocal = false;



        /**
         * 尋找 iframe 裡的 <video> 並掛上事件監聽。
         * 播放器常常是等一下才動態生成 <video>，所以找不到就每 0.8 秒重試 (輪詢)，直到找到為止。
         */
        function findAndHookVideo() {

            video = document.querySelector('video');

            if (!video) {

                setTimeout(findAndHookVideo, 800);

                return;

            }



            /*
             * notifyParent(eventType, extra)：把影片目前狀態打包，用 postMessage 傳給最上層母頁面。
             *   eventType 事件種類 (play / pause / seeking / seeked / timeupdate / ready ...)
             *   extra     額外要覆蓋或附加的欄位
             * source: 'kazumi_player_bridge' 是自訂的「暗號」，母頁面靠它確認這則訊息是橋樑傳來的，不是別的雜訊。
             * 目標來源用 '*' 是因為不同播放器網域不固定；整段包 try/catch 避免傳送失敗讓播放器出錯。
             */
            // 雙向同步：將 iframe 內真實影片狀態回傳給 Web Library 劇院母頁面

            const notifyParent = (eventType, extra = {}) => {

                try {

                    window.top.postMessage({

                        source: 'kazumi_player_bridge',

                        type: eventType,

                        currentTime: video.currentTime,

                        duration: video.duration || 0,

                        paused: video.paused,

                        ...extra

                    }, '*');

                } catch (e) {}

            };



            video.addEventListener('play', () => notifyParent('play'));

            video.addEventListener('pause', () => notifyParent('pause'));

            video.addEventListener('ended', () => notifyParent('pause'));

            video.addEventListener('seeking', () => {

                isSeekingLocal = true;

                notifyParent('seeking', { currentTime: video.currentTime });

            });

            video.addEventListener('seeked', () => {

                isSeekingLocal = false;

                notifyParent('seeked', { currentTime: video.currentTime });

            });

            // timeupdate 在播放時每秒會觸發好幾次，這裡做節流：時間變動不到 0.35 秒就不回報；
            // 使用者正在拖動進度條 (isSeekingLocal) 期間也不回報，避免和跳轉事件打架。
            video.addEventListener('timeupdate', () => {

                if (isSeekingLocal) return;

                // 每隔至少 0.35 秒或時間跨度較大時回傳一次，避免過度廣播

                if (Math.abs(video.currentTime - lastReportedTime) >= 0.35) {

                    lastReportedTime = video.currentTime;

                    notifyParent('timeupdate', { currentTime: video.currentTime, duration: video.duration });

                }

            });



            // 立即回報一次初始狀態

            notifyParent('ready', { currentTime: video.currentTime, duration: video.duration });



            // 轉發 iframe 內部滾輪事件與全螢幕快捷鍵給母頁面，避免外嵌播放器攔截滾輪調音量與 F 全螢幕

            window.addEventListener('wheel', (e) => {

                const delta = e.deltaY < 0 ? 5 : -5;

                try {

                    window.top.postMessage({

                        source: 'kazumi_player_bridge',

                        type: 'wheel',

                        delta: delta

                    }, '*');

                } catch (err) {}

            }, { passive: true });



            window.addEventListener('keydown', (e) => {

                if (e.code === 'KeyF' || e.key === 'f' || e.key === 'F') {

                    e.preventDefault();

                    try {

                        window.top.postMessage({

                            source: 'kazumi_player_bridge',

                            type: 'fullscreen'

                        }, '*');

                    } catch (err) {}

                }

            });



            console.log('[Web Library Tampermonkey Bridge] 🎬 已成功掛接 iframe 內置播放器！');

        }



        /*
         * 反方向：母頁面 → iframe。
         * 母頁面送來 { target: 'kazumi_iframe_video', action: ... } 的訊息，這裡依 action 控制影片：
         *   pause 暫停 / play 播放 / seek 跳到指定秒數 / toggle 播放暫停切換 / volume 調音量與靜音。
         * 先檢查 target 暗號，不是給我們的訊息就直接忽略。
         */
        // 接收母頁面的主控指令（暫停、播放、進度軸跳轉）

        window.addEventListener('message', (e) => {

            if (!e.data || e.data.target !== 'kazumi_iframe_video') return;

            if (!video) video = document.querySelector('video');

            if (!video) return;



            const action = e.data.action;

            if (action === 'pause') {

                video.pause();

            } else if (action === 'play') {

                video.play().catch(() => {});

            } else if (action === 'seek') {

                const targetTime = Number(e.data.time);

                if (!isNaN(targetTime)) {

                    video.currentTime = targetTime;

                }

            } else if (action === 'toggle') {

                if (video.paused) video.play().catch(() => {});

                else video.pause();

            } else if (action === 'volume') {

                const vol = Number(e.data.volume);

                if (!isNaN(vol)) {

                    video.volume = Math.max(0, Math.min(1, vol));

                }

                if (typeof e.data.muted === 'boolean') {

                    video.muted = e.data.muted;

                }

            }

        });



        // 啟動輪詢探測原生 <video>

        findAndHookVideo();

    }



    /*
     * config：集中管理使用者設定的小物件，用 getter/setter 包裝 GM_getValue / GM_setValue。
     * 好處是其他地方只要寫 config.serverUrl、config.showFab 就能讀寫，不用記儲存用的 key 名稱。
     *   serverUrl 後端書籤 API 網址 (預設本機 8090 埠)
     *   showFab   是否顯示畫面上的懸浮球 (預設顯示)
     *   fabPos    懸浮球被拖曳後的位置 { left, top }；null 代表用預設右下角
     */
    // 讀取設定與儲存的位置

    const config = {

        get serverUrl() {
            // 舊版預設網址用過 8080 / 8000 埠，現在後端改成 8090，
            // 讀到舊值時自動改成 8090 並存回去，使用者不用手動改設定。
            let val = GM_getValue("wl_server_url", "http://localhost:8090/api/user/bookmarks");
            if (val.includes(":8080") || val.includes(":8000")) {
                val = val.replace(":8080", ":8090").replace(":8000", ":8090");
                GM_setValue("wl_server_url", val);
            }
            return val;
        },

        set serverUrl(v) { GM_setValue("wl_server_url", v); },

        get showFab() { return GM_getValue("wl_show_fab", true); },

        set showFab(v) { GM_setValue("wl_show_fab", v); },

        get fabPos() { return GM_getValue("wl_fab_pos", null); },

        set fabPos(v) { GM_setValue("wl_fab_pos", v); }

    };

    // 舊版「個人 API Token」後端從未驗證，已移除；順手清掉殘留的設定值

    GM_deleteValue("wl_api_token");



    /**
     * 偵測目前網頁的資訊，用來預先填好收藏表單。
     * 觸發時機：每次打開收藏對話框時 (toggleCollectorModal 呼叫)。
     * 回傳物件：{ url 網址, title 標題, category 分類, defaultTags 預設標籤, coverUrl 封面圖網址, desc 簡介 }
     * 邏輯：先抓通用的 og:image / description 等 meta 標籤；再依網站網域 (YouTube、B站、GitHub、
     * 漫畫站、動漫站) 套用專屬規則，例如 YouTube 用影片 ID 組出縮圖網址。
     */
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

        } else if (/(^|\.)(copymanga|mangacopy|dm5\.com|manhuagui\.com|mangadex\.org|baozimh\.com|kuaikanmanhua\.com|webtoons\.com|wenku8|bilinovel\.com|linovelib\.com)/.test(host) || host === "manga.bilibili.com") {

            // 漫畫 / 小說站 (與 Web Library 首頁分類方案一致)

            category = "manga";

            defaultTags = ["漫畫", "ACG資源"];

            const posterImg = document.querySelector(".anime_cover img, .coverList img, .data .poster img, .pic img");

            if (posterImg && posterImg.src) coverUrl = posterImg.src;

        } else if (host.includes("ani.gamer.com.tw") || host.includes("bangumi.tv") || host.includes("bgm.tv") || host.includes("anime1.me") || host.includes("agefans") || host.includes("myself-bbs.com")) {

            category = "anime";

            defaultTags = ["動畫", "ACG資源"];

            // Bangumi 條目同時有書籍：依條目類型 (h1.nameSingle small) 區分

            if (/bangumi\.tv|bgm\.tv/.test(host)) {

                const subjType = document.querySelector("h1.nameSingle small")?.textContent || "";

                if (/漫画|漫畫|小说|小說|书籍|書籍|画集|绘本|Novel|Manga/i.test(subjType)) {

                    category = "manga";

                    defaultTags = ["漫畫", "書籍", "ACG資源"];

                }

            }

            const posterImg = document.querySelector(".anime_cover img, .coverList img, .data .poster img, .pic img");

            if (posterImg && posterImg.src) coverUrl = posterImg.src;

        }



        // 封面若是相對路徑 (例如 /img/a.jpg)，補成完整網址，否則圖書館那邊會讀不到圖
        if (coverUrl && !coverUrl.startsWith("http")) {

            try { coverUrl = new URL(coverUrl, window.location.origin).href; } catch(e){}

        }



        return { url, title, category, defaultTags, coverUrl, desc: ogDesc };

    }



    // 3. 【核心修復】建立支援「自由拖曳、尺寸鎖定（防 Bangumi 放大）、顯示開關」的 FAB 懸浮球

    let fabElement = null;



    /**
     * 建立畫面角落那顆可拖曳的「FAB 懸浮球」(Floating Action Button)。
     * 觸發時機：頁面載入後由 setupTrigger 呼叫，之後每 2.5 秒也會再呼叫一次 (已存在就只更新顯示狀態，不會重複建立)。
     * 重點：
     *  - 用 position: fixed 加 !important 的內嵌樣式，並固定 48px，避免被宿主網站的 CSS 影響或放大。
     *  - z-index 取最大值 2147483647，確保蓋在任何網頁元素上面。
     *  - 以 mousedown / mousemove / mouseup 自己實作拖曳；位置存進 config.fabPos，下次開網頁還記得。
     *  - 移動超過 5px 才算「拖曳」，否則視為點擊，點擊會開啟收藏對話框。
     */
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



        // 圖示用 createElementNS 一個個建 SVG 節點，不用 innerHTML。
        // 因為 YouTube 等網站啟用 Trusted Types 安全政策，直接塞 HTML 字串會被瀏覽器擋掉。
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



        // 滑鼠按下：記下起點與目前位置；mousemove / mouseup 監聽掛在 window 上，
        // 這樣滑鼠移太快跑出球外也不會「掉球」，放開滑鼠時再移除監聽。
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



    /**
     * 依設定 config.showFab 顯示或隱藏懸浮球。
     * 觸發時機：建立懸浮球時、儲存設定時、從選單切換時。
     * 隱藏時仍可用 Alt + B 收藏，只是畫面上看不到球。
     */
    function applyFabVisibility() {

        if (!fabElement) return;

        if (config.showFab) {

            fabElement.style.setProperty("display", "flex", "important");

        } else {

            fabElement.style.setProperty("display", "none", "important");

        }

    }



    // 4. 原生 DOM 建立 Modal 視窗 (相容 YouTube Trusted Types)

    /**
     * 建立「收藏至 Web Library」對話框 (全螢幕半透明遮罩 + 中間白色卡片)，只會建立一次，之後重複使用。
     * 觸發時機：第一次呼叫 toggleCollectorModal 時。
     * 全部用 document.createElement 手動組 DOM (不用 innerHTML)，才能相容 YouTube 的 Trusted Types 限制。
     * 結構：Header (標題、設定、關閉) → 設定抽屜 (伺服器網址、懸浮球開關) → 表單 (封面、標題、分類、標籤、描述) → 按鈕。
     * 另外注入一段 <style>，強制輸入框用淺色，避免 GitHub / YouTube 的深色模式把字變成白底白字。
     */
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

            color-scheme: light !important;

            zoom: 1 !important;

        `;



        // 注入高優先級隔離樣式，徹底防禦 GitHub / YouTube / Bilibili 等宿主網站之 Dark Mode 污染

        const style = document.createElement("style");

        style.id = "wl-isolated-style";

        style.textContent = `

            #wl-collector-modal, #wl-collector-modal * {

                box-sizing: border-box !important;

                color-scheme: light !important;

            }

            #wl-modal-card {

                background: #ffffff !important;

                background-color: #ffffff !important;

                color: #0f172a !important;

            }

            #wl-collector-modal input,

            #wl-collector-modal textarea,

            #wl-collector-modal select {

                color-scheme: light !important;

                background: #ffffff !important;

                background-color: #ffffff !important;

                color: #0f172a !important;

                -webkit-text-fill-color: #0f172a !important;

                caret-color: #0f172a !important;

                border: 1px solid #cbd5e1 !important;

                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;

                font-size: 13px !important;

                line-height: 1.4 !important;

            }

            #wl-collector-modal input:focus,

            #wl-collector-modal textarea:focus,

            #wl-collector-modal select:focus {

                background: #ffffff !important;

                background-color: #ffffff !important;

                border-color: #4f46e5 !important;

                outline: none !important;

                box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.18) !important;

            }

            #wl-collector-modal input::placeholder,

            #wl-collector-modal textarea::placeholder {

                color: #94a3b8 !important;

                -webkit-text-fill-color: #94a3b8 !important;

                opacity: 1 !important;

            }

            #wl-collector-modal label {

                color: #475569 !important;

                -webkit-text-fill-color: #475569 !important;

            }

            #wl-collector-modal button {

                font-family: inherit !important;

            }

        `;

        overlay.appendChild(style);



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
        titleSpan.title = "Alt + B：收藏本頁 ｜ Alt + N：快捷記事本";
        const noteHint = document.createElement("small");
        noteHint.textContent = "  Alt+N 記事本";
        noteHint.style.cssText = "color: #94a3b8 !important; font-weight: 400; font-size: 11px; margin-left: 6px;";
        titleSpan.appendChild(noteHint);

        titleSpan.style.cssText = "font-weight: 600; font-size: 15px;";

        header.appendChild(titleSpan);



        const btnGroup = document.createElement("div");

        btnGroup.style.cssText = "display: flex; align-items: center; gap: 8px;";



        const setBtn = document.createElement("button");

        setBtn.id = "wl-settings-toggle-btn";

        setBtn.textContent = "⚙️";

        setBtn.title = "設定伺服器位址與懸浮球開關";

        setBtn.style.cssText = "background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 2px 4px;";

        btnGroup.appendChild(setBtn);



        const closeBtn = document.createElement("button");

        closeBtn.id = "wl-close-btn";

        closeBtn.textContent = "✕";

        closeBtn.style.cssText = "background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;";

        btnGroup.appendChild(closeBtn);



        header.appendChild(btnGroup);

        card.appendChild(header);



        // --- 抽屜 Drawer (含伺服器位址與懸浮按鈕開關) ---

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



        const urlLabel = document.createElement("label");

        urlLabel.textContent = "伺服器 API 位址";

        urlLabel.style.cssText = "display: block; font-weight: 600; margin-bottom: 4px; color: #475569 !important;";

        drawer.appendChild(urlLabel);



        const urlInput = document.createElement("input");

        urlInput.id = "wl-cfg-url";

        urlInput.value = config.serverUrl;

        urlInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; margin-bottom: 8px; background: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important;";

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

        previewImg.setAttribute("referrerpolicy", "no-referrer");

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

        titleInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; background: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important; margin-bottom: 10px;";

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

        catSelect.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; background: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important;";

        [

            { val: "web", text: "💻 一般網頁" },

            { val: "video", text: "🎬 影片影音" },

            { val: "anime", text: "📺 動畫" },

            { val: "manga", text: "📚 漫畫 / 小說" },

            { val: "other", text: "📦 資源 / 其他" }

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

        tagInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; background: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important;";

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

        covInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: #ffffff !important; color: #334155 !important; -webkit-text-fill-color: #334155 !important; margin-bottom: 10px;";

        body.appendChild(covInput);



        // 簡介

        const dLabel = document.createElement("label");

        dLabel.textContent = "筆記描述 (選填)";

        dLabel.style.cssText = "display: block; font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 4px;";

        body.appendChild(dLabel);

        const descArea = document.createElement("textarea");

        descArea.id = "wl-input-desc";

        descArea.placeholder = "輸入備註或重點...";

        descArea.style.cssText = "width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; height: 42px; resize: none; background: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important; margin-bottom: 16px;";

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



        // 按「確認收藏」：把表單內容組成一筆書籤物件 (payload) 送出。
        // id 用「時間戳 + 隨機字串」確保不重複；標籤用逗號/空白切開並濾掉空字串；
        // pinned、clicks 是圖書館網站用的欄位，新書籤預設為未置頂、點擊 0 次。
        submitBtn.addEventListener("click", () => {

            const now = Date.now();

            submitBookmark({

                id: 'bm_' + now + '_' + Math.random().toString(36).substring(2, 6),

                title: titleInput.value.trim() || document.title || '未命名網頁',

                url: window.location.href,

                category: catSelect.value || 'web',

                tags: tagInput.value.split(/[,，\s]+/).filter(Boolean),

                cover: covInput.value.trim(),

                desc: descArea.value.trim(),

                pinned: false,

                clicks: 0,

                createdAt: new Date().toISOString()

            });

        });

    }



    /**
     * 開啟或關閉收藏對話框 (開著就關、關著就開)。
     * 觸發時機：點懸浮球、按 Alt + B、Tampermonkey 選單的「快速開啟收藏對話框」。
     * 開啟時會先呼叫 detectPageMetadata 抓資料，自動填入標題、分類、標籤、封面、簡介，並顯示封面預覽。
     */
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

            const pimg = document.getElementById("wl-img-preview");

            if (meta.coverUrl) {

                pimg.onerror = function() { pbox.style.display = "none"; };

                pimg.onload = function() { pbox.style.display = "block"; };

                pimg.src = meta.coverUrl;

                pbox.style.display = "block";

            } else {

                pbox.style.display = "none";

            }



            modal.style.setProperty("display", "flex", "important");

        } else {

            modal.style.setProperty("display", "none", "important");

        }

    }



    /**
     * 把書籤送到圖書館後端。
     * 參數 payload：一筆書籤物件 (id、title、url、category、tags、cover、desc ...)。
     * 流程：依序嘗試候選伺服器網址 (本機 8090 → Docker 8095 → 127.0.0.1 版本)，
     *   1. 先 GET 讀回目前已有的書籤清單；
     *   2. 把新書籤放最前面，並移除網址相同的舊書籤 (避免重複)；
     *   3. 再 POST 整份清單回去。
     * 任一步失敗或逾時就換下一個網址，全部失敗才改用 handleLocalFallback (複製到剪貼簿)。
     * 為何用 GM_xmlhttpRequest 而不是 fetch：使用者可能在 youtube.com 之類的網站上，
     * 一般 fetch 打 localhost 會被 CORS 跨網域限制擋下，GM_xmlhttpRequest 由擴充功能代送就沒這個問題
     * (但目標主機要列在上方 @connect 白名單)。
     */
    // 6. 送出資料 (具備 8090 / 8095 多埠號自動容錯感知探測架構)
    function submitBookmark(payload) {
        const btn = document.getElementById("wl-submit-btn");
        if (btn) {
            btn.disabled = true;
            btn.textContent = "傳送中...";
        }

        // 候選端點：每次都先試本機 8090，連不上才送 Docker 8095 (兩邊資料各自獨立)
        // 只有在設定面板填了其他伺服器 (非 8090/8095) 時才優先使用該網址
        const defaultUrls = [
            "http://localhost:8090/api/user/bookmarks",
            "http://localhost:8095/api/user/bookmarks",
            "http://127.0.0.1:8090/api/user/bookmarks",
            "http://127.0.0.1:8095/api/user/bookmarks"
        ];
        const customUrl = config.serverUrl;
        const candidateUrls = customUrl && !defaultUrls.includes(customUrl)
            ? [customUrl, ...defaultUrls]
            : defaultUrls;

        // currentIndex 記錄試到第幾個候選網址了
        let currentIndex = 0;

        // tryNext：試下一個候選伺服器 (先 GET 再交給 executePost)；用完所有網址就走本機備援
        function tryNext() {
            if (currentIndex >= candidateUrls.length) {
                handleLocalFallback(payload);
                return;
            }

            const currentUrl = candidateUrls[currentIndex++];

            // 1. 先 GET 現有書籤合併 (防止覆蓋已有書籤)
            GM_xmlhttpRequest({
                method: "GET",
                url: currentUrl,
                timeout: 2000,
                onload: function(getRes) {
                    if (getRes.status >= 200 && getRes.status < 300) {
                        let existing = [];
                        let username = 'guest';
                        try {
                            const json = JSON.parse(getRes.responseText);
                            if (Array.isArray(json.bookmarks)) existing = json.bookmarks;
                            if (json.user && json.user !== 'default') username = json.user;
                        } catch (e) {}

                        // 去掉舊清單裡網址相同的書籤，再把新的放最前面，達到「同網址只留一筆、最新在前」。
                        // 這裡送整份 bookmarks 是因為後端以「整份清單」方式儲存，不先合併會把原有書籤洗掉。
                        const filtered = existing.filter(b => b.url !== payload.url);
                        const merged = [payload, ...filtered];
                        const postBody = { user: username, bookmark: payload, bookmarks: merged };
                        executePost(currentUrl, postBody);
                    } else {
                        executePost(currentUrl, { bookmark: payload, bookmarks: [payload] });
                    }
                },
                onerror: () => tryNext(),
                ontimeout: () => tryNext()
            });
        }

        // executePost：把合併後的資料 POST 給伺服器 (JSON 格式)。成功就顯示通知並關閉對話框，失敗改試下一個網址。
        function executePost(url, postBody) {
            GM_xmlhttpRequest({
                method: "POST",
                url: url,
                headers: {
                    "Content-Type": "application/json"
                },
                data: JSON.stringify(postBody),
                timeout: 3000,
                onload: function(res) {
                    if (res.status >= 200 && res.status < 300) {
                        if (btn) {
                            btn.disabled = false;
                            btn.textContent = "確認收藏";
                        }
                        const portLabel = url.includes(":8095/") ? "Docker 8095" : url.includes(":8090/") ? "Port 8090" : new URL(url).host;
                        showNotice(`🎉 成功收藏至 Web Library！(${portLabel})`);
                        const modal = document.getElementById("wl-collector-modal");
                        if (modal) modal.style.setProperty("display", "none", "important");
                    } else {
                        tryNext();
                    }
                },
                onerror: () => tryNext(),
                ontimeout: () => tryNext()
            });
        }

        tryNext();
    }

    /**
     * 備援：所有伺服器都連不上時呼叫。
     * 把書籤 JSON 複製到剪貼簿，使用者可以之後到圖書館網站手動貼上新增，資料就不會白白遺失。
     */
    function handleLocalFallback(payload) {

        const btn = document.getElementById("wl-submit-btn");

        btn.disabled = false;

        btn.textContent = "確認收藏";



        navigator.clipboard.writeText(JSON.stringify(payload));

        showNotice("✨ 伺服器未開啟，收藏已複製！可回圖書館貼上新增。");

        document.getElementById("wl-collector-modal").style.setProperty("display", "none", "important");

    }



    /**
     * 在畫面右下角跳出一則深色小提示，4 秒後自動消失。
     * 參數 text：要顯示的文字。因為不能保證宿主網站的樣式，所以全部用 !important 的內嵌樣式。
     */
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



    /*
     * Alt + B 快捷鍵。第三個參數 true 代表在「捕獲階段」就先攔截，
     * 比網頁自己的快捷鍵處理更早拿到事件；preventDefault / stopPropagation 避免網頁也跟著反應。
     */
    // 7. 最高捕獲優先級快捷鍵監聽

    window.addEventListener("keydown", (e) => {

        if (e.altKey && (e.key === "b" || e.key === "B" || e.code === "KeyB")) {

            e.preventDefault();

            e.stopPropagation();

            toggleCollectorModal();

        }

    }, true);



    /*
     * 在 Tampermonkey 圖示的選單加入指令 (用 GM_registerMenuCommand)：
     * 開收藏對話框、切換懸浮球顯示。先檢查該函式存在才呼叫，避免在不支援的管理器上報錯。
     */
    // 8. 註冊 Tampermonkey 快捷指令選單

    if (typeof GM_registerMenuCommand !== "undefined") {

        GM_registerMenuCommand("快速開啟收藏對話框 (Alt+B)", toggleCollectorModal);

        GM_registerMenuCommand("切換懸浮球顯示 / 隱藏", () => {

            config.showFab = !config.showFab;

            applyFabVisibility();

            showNotice(config.showFab ? "已開啟懸浮球顯示！" : "已隱藏懸浮球（仍可按 Alt+B 呼叫）");

        });

    }



    /*
     * 以下是「快捷記事本」功能的總說明：
     *  - Alt + N 開關一個小視窗，可寫標題與內容，勾選後會附上當前畫面截圖。
     *  - 筆記以 category: "note" 的書籤形式存進圖書館，送出流程和上面收藏相同 (GET 合併後 POST)。
     *  - 草稿用 GM_setValue 暫存，不小心關掉或換網頁也不會遺失。
     *  - 函式名稱都以 wlNote 開頭，與前面的收藏面板分開，避免互相干擾。
     */
    // ==========================================================
    // 10. 快捷記事本 (Alt + N)：隨手記下標題與內容，可附當前畫面截圖，一鍵存進圖書館
    //     獨立區塊：自帶 Shadow DOM 樣式與儲存流程，不動上面的收藏面板程式
    // ==========================================================
    // WL_NOTE_DRAFT_KEY：草稿存在 Tampermonkey 儲存空間用的名稱
    // WL_NOTE_SHOT_MAX_W：截圖最大寬度 (像素)，限制大小避免上傳太肥
    // wlNoteHost：記事本最外層的 DOM 元素 (還沒建立時是 null)
    // wlNoteUi：記事本裡的輸入框、核取方塊、按鈕等元素參照，方便其他函式取用
    const WL_NOTE_DRAFT_KEY = "wl_note_draft";
    const WL_NOTE_SHOT_MAX_W = 1280;
    let wlNoteHost = null;
    let wlNoteUi = null;

    // 讀取暫存的草稿，回傳 { title, content, shot }；沒有草稿或內容壞掉就回傳空白草稿
    function wlNoteLoadDraft() {
        try {
            const d = JSON.parse(GM_getValue(WL_NOTE_DRAFT_KEY, "{}") || "{}");
            return { title: d.title || "", content: d.content || "", shot: !!d.shot };
        } catch (e) {
            return { title: "", content: "", shot: false };
        }
    }

    // 把目前輸入的標題、內容與「附截圖」勾選狀態存起來。每次輸入與關閉視窗時都會呼叫。
    function wlNoteSaveDraft() {
        if (!wlNoteUi) return;
        GM_setValue(WL_NOTE_DRAFT_KEY, JSON.stringify({
            title: wlNoteUi.title.value,
            content: wlNoteUi.content.value,
            shot: wlNoteUi.shot.checked
        }));
    }

    // 記事本目前是否顯示中 (回傳 true / false)
    function wlNoteIsOpen() {
        return !!(wlNoteHost && wlNoteHost.style.display !== "none");
    }

    // 建立記事本視窗 (只建一次)。
    // 使用 Shadow DOM (attachShadow)：把記事本的 HTML 與 CSS 關在獨立的「影子」裡，
    // 網頁原本的樣式進不來、記事本的樣式也不會跑出去，所以在任何網站看起來都一樣。
    // 視窗用 position: fixed 固定在畫面正中間，z-index 比懸浮球小 1，讓兩者不互相蓋掉。
    function wlNoteBuild() {
        wlNoteHost = document.createElement("div");
        wlNoteHost.id = "wl-quick-note-host";
        wlNoteHost.style.cssText = "position:fixed!important;top:50%!important;left:50%!important;transform:translate(-50%,-50%)!important;z-index:2147483646!important;display:none;";
        // mode: "open" 讓外面仍能用 wlNoteHost.shadowRoot 取得內容 (方便除錯)
        const root = wlNoteHost.attachShadow({ mode: "open" });
        root.innerHTML = `
            <style>
                :host { all: initial; }
                .box { width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow-y: auto; background: #ffffff; color: #0f172a; border-radius: 12px;
                       box-shadow: 0 16px 40px rgba(15,23,42,.35); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif; }
                .hd { background: #0f172a; color: #fff; padding: 10px 14px; display: flex; align-items: center; gap: 8px; }
                .hd b { font-size: 14px; font-weight: 600; flex: 1; }
                .hd small { color: #94a3b8; }
                .x { background: none; border: 0; color: #94a3b8; font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px; }
                .bd { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
                input[type=text], textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 7px 9px;
                       font: inherit; color: #0f172a; background: #f8fafc; outline: none; }
                input[type=text]:focus, textarea:focus { border-color: #2563eb; background: #fff; }
                textarea { min-height: 150px; resize: vertical; }
                label { display: flex; align-items: center; gap: 6px; color: #334155; cursor: pointer; user-select: none; }
                .ft { display: flex; gap: 8px; align-items: center; }
                .ft span { flex: 1; color: #64748b; font-size: 12px; }
                button.ghost { background: #f1f5f9; color: #334155; border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; font: inherit; }
                button.save { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; font: inherit; font-weight: 600; }
                button:disabled { opacity: .6; cursor: wait; }
            </style>
            <div class="box" role="dialog" aria-label="快捷記事本">
                <div class="hd"><b>📝 快捷記事本</b><small>Alt+N 開關 · Esc 關閉</small><button class="x" title="關閉 (草稿會保留)">✕</button></div>
                <div class="bd">
                    <input type="text" class="t" placeholder="標題（留空則取內容第一行）" maxlength="200">
                    <textarea class="c" placeholder="記點什麼…（內容會自動暫存，誤關也不會遺失）"></textarea>
                    <label><input type="checkbox" class="s"> 附上當前畫面截圖</label>
                    <div class="ft">
                        <span class="st">草稿已自動暫存</span>
                        <button class="ghost clr" title="清空草稿">清空</button>
                        <button class="save">存進圖書館</button>
                    </div>
                </div>
            </div>`;
        // 把常用元素的參照記起來 (用 class 名稱在 shadow root 內查詢)
        wlNoteUi = {
            title: root.querySelector(".t"),
            content: root.querySelector(".c"),
            shot: root.querySelector(".s"),
            status: root.querySelector(".st"),
            save: root.querySelector(".save")
        };
        // 一輸入就自動存草稿；下面是各按鈕的事件：✕ 關閉、清空 (會先確認)、存進圖書館
        [wlNoteUi.title, wlNoteUi.content, wlNoteUi.shot].forEach(el => el.addEventListener("input", wlNoteSaveDraft));
        wlNoteUi.shot.addEventListener("change", wlNoteSaveDraft);
        root.querySelector(".x").addEventListener("click", wlNoteClose);
        root.querySelector(".clr").addEventListener("click", () => {
            if ((wlNoteUi.title.value || wlNoteUi.content.value) && !confirm("確定清空這則筆記草稿？")) return;
            wlNoteUi.title.value = "";
            wlNoteUi.content.value = "";
            wlNoteSaveDraft();
            wlNoteUi.content.focus();
        });
        wlNoteUi.save.addEventListener("click", wlNoteSubmit);
        // 輸入時不讓網頁自己的快捷鍵 (例如 YouTube 的 k / f / 空白鍵) 搶走按鍵
        ["keydown", "keyup", "keypress"].forEach(type => wlNoteHost.addEventListener(type, e => {
            if (!(e.altKey && e.code === "KeyN")) e.stopPropagation();
        }));
        (document.documentElement || document.body).appendChild(wlNoteHost);
    }

    // 開啟記事本：必要時先建立、載入上次草稿填入欄位，再顯示並把游標放到合適的輸入框 (已有標題就跳到內容)
    function wlNoteOpen() {
        if (!wlNoteHost || !wlNoteHost.isConnected) wlNoteBuild();
        const d = wlNoteLoadDraft();
        wlNoteUi.title.value = d.title;
        wlNoteUi.content.value = d.content;
        wlNoteUi.shot.checked = d.shot;
        wlNoteUi.status.textContent = "草稿已自動暫存";
        wlNoteHost.style.display = "block";
        setTimeout(() => (d.title ? wlNoteUi.content : wlNoteUi.title).focus(), 0);
    }

    // 關閉記事本：先存草稿再隱藏 (只是隱藏，內容不會丟)
    function wlNoteClose() {
        if (!wlNoteHost) return;
        wlNoteSaveDraft();
        wlNoteHost.style.display = "none";
    }

    // 開關切換。Alt + N 與 Tampermonkey 選單都呼叫這個函式
    function wlNoteToggle() {
        wlNoteIsOpen() ? wlNoteClose() : wlNoteOpen();
    }

    /**
     * 擷取目前瀏覽器可視範圍的截圖，回傳 JPEG 的 data URL 字串 (data:image/jpeg;base64,...)。
     * 使用 @require 載入的 html2canvas：它是把頁面 DOM 重新畫到 canvas 上，並非真的螢幕擷圖。
     * 步驟：先隱藏記事本 (不然會拍到自己) → 等兩個 requestAnimationFrame 讓畫面真的更新 →
     *   以目前捲動位置與視窗大小為範圍截圖 → 太寬就縮小 → 轉成 JPEG 壓縮；
     *   若檔案大於約 3.5MB 再降低品質。最後無論成功失敗都用 finally 把記事本顯示回來。
     * html2canvas 沒載入或截圖失敗會丟出錯誤，由呼叫端 (wlNoteSubmit) 捕捉處理。
     * useCORS: 允許讀取跨網域圖片，否則 canvas 會被污染而無法輸出。
     */
    // 擷取當前可視畫面 (截圖前先藏起記事本本身)，縮到寬度 1280 內並轉 JPEG 0.7
    async function wlNoteCaptureViewport() {
        if (typeof html2canvas !== "function") throw new Error("html2canvas 未載入");
        wlNoteHost.style.display = "none";
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
            const vw = document.documentElement.clientWidth || window.innerWidth;
            const vh = window.innerHeight;
            const canvas = await html2canvas(document.documentElement, {
                x: window.scrollX, y: window.scrollY, width: vw, height: vh,
                windowWidth: vw, windowHeight: vh,
                scale: Math.min(1, WL_NOTE_SHOT_MAX_W / vw),
                useCORS: true, logging: false, backgroundColor: "#ffffff",
                ignoreElements: el => el === wlNoteHost
            });
            let out = canvas;
            if (canvas.width > WL_NOTE_SHOT_MAX_W) {
                out = document.createElement("canvas");
                out.width = WL_NOTE_SHOT_MAX_W;
                out.height = Math.round(canvas.height * WL_NOTE_SHOT_MAX_W / canvas.width);
                out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
            }
            let dataUrl = out.toDataURL("image/jpeg", 0.7);
            if (dataUrl.length > 3.5 * 1024 * 1024) dataUrl = out.toDataURL("image/jpeg", 0.5);
            return dataUrl;
        } finally {
            wlNoteHost.style.display = "block";
        }
    }

    /**
     * 把 GM_xmlhttpRequest (回呼寫法) 包成 Promise，這樣可以用 await 寫得比較好讀。
     * 參數 opts：GM_xmlhttpRequest 的選項 (method、url、headers、data、timeout ...)。
     * 回傳 Promise：HTTP 狀態 2xx 時 resolve 回應物件；其他狀態、連線失敗或逾時都 reject 並帶錯誤訊息。
     */
    function wlNoteRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: 3000,
                ...opts,
                onload: r => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error("HTTP " + r.status))),
                onerror: () => reject(new Error("連線失敗")),
                ontimeout: () => reject(new Error("逾時"))
            });
        });
    }

    /**
     * 按下「存進圖書館」後的完整流程。
     *  1. 檢查標題與內容不可兩者皆空；標題空白就取內容第一行。
     *  2. 若勾選截圖，呼叫 wlNoteCaptureViewport 取得圖片 (失敗只提示，筆記照存)。
     *  3. 組出筆記的 payload (category: "note")，網址後面加 #wl-<id> 讓每則筆記網址都不同。
     *  4. 逐一嘗試候選伺服器：GET 現有書籤 → (有截圖) 上傳截圖換成檔案路徑 → POST 合併後的清單。
     *  5. 成功就清空草稿並關閉；全部連不上就保留草稿並把 JSON 複製到剪貼簿。
     */
    async function wlNoteSubmit() {
        const content = wlNoteUi.content.value.trim();
        const firstLine = content.split("\n")[0].trim().slice(0, 60);
        const title = wlNoteUi.title.value.trim() || firstLine;
        if (!title && !content) {
            wlNoteUi.status.textContent = "請先輸入標題或內容";
            return;
        }

        wlNoteUi.save.disabled = true;
        let shot = "";
        if (wlNoteUi.shot.checked) {
            wlNoteUi.status.textContent = "擷取畫面中…";
            try {
                shot = await wlNoteCaptureViewport();
            } catch (e) {
                showNotice("⚠️ 截圖失敗，筆記將不附截圖：" + e.message);
            }
        }

        // 每則筆記有自己的 id，url 加上 #wl-note_<id>：同一頁記多則也不會被「同網址去重」互相覆蓋
        const id = "note_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const payload = {
            id,
            title: title || "未命名筆記",
            url: location.href.split("#")[0] + "#wl-" + id,
            category: "note",
            tags: ["筆記"],
            desc: content,
            cover: "",
            pinned: false,
            clicks: 0,
            createdAt: new Date().toISOString()
        };

        // 與收藏面板相同的候選端點順序：本機 8090 → Docker 8095 (設定面板的自訂網址優先)
        const defaultUrls = [
            "http://localhost:8090/api/user/bookmarks",
            "http://localhost:8095/api/user/bookmarks",
            "http://127.0.0.1:8090/api/user/bookmarks",
            "http://127.0.0.1:8095/api/user/bookmarks"
        ];
        const customUrl = config.serverUrl;
        const candidates = customUrl && !defaultUrls.includes(customUrl) ? [customUrl, ...defaultUrls] : defaultUrls;

        wlNoteUi.status.textContent = "傳送中…";
        // 逐個伺服器嘗試；用 continue 代表「這台不行，換下一台」，成功則 return 結束整個函式
        for (const apiUrl of candidates) {
            let existing = [];
            let username = "guest";
            try {
                const getRes = await wlNoteRequest({ method: "GET", url: apiUrl, timeout: 2000 });
                const json = JSON.parse(getRes.responseText);
                if (Array.isArray(json.bookmarks)) existing = json.bookmarks;
                if (json.user && json.user !== "default") username = json.user;
            } catch (e) {
                continue; // 這台伺服器連不上，換下一個
            }

            // 截圖上傳到同一台伺服器，存成檔案後只把網址寫進書籤 cover
            let shotFailed = false;
            if (shot) {
                try {
                    // 截圖是很大的 base64 字串，不直接塞進書籤資料，
                    // 而是先 POST 到後端 /api/bookmarks/screenshot 存成檔案，拿回檔案路徑填入 cover 欄位。
                    // new URL(apiUrl).origin 取出「協定+主機+埠」，確保傳給同一台伺服器。
                    const upRes = await wlNoteRequest({
                        method: "POST",
                        url: new URL(apiUrl).origin + "/api/bookmarks/screenshot",
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ image: shot }),
                        timeout: 15000
                    });
                    payload.cover = JSON.parse(upRes.responseText).path || "";
                } catch (e) {
                    shotFailed = true;
                }
            }

            // 合併書籤清單：新筆記放最前面，並排除相同 id 或相同網址的舊資料，再整份 POST 回去
            const merged = [payload, ...existing.filter(b => b.id !== payload.id && b.url !== payload.url)];
            try {
                await wlNoteRequest({
                    method: "POST",
                    url: apiUrl,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ user: username, bookmark: payload, bookmarks: merged })
                });
            } catch (e) {
                continue;
            }

            const portLabel = apiUrl.includes(":8095/") ? "Docker 8095" : apiUrl.includes(":8090/") ? "Port 8090" : new URL(apiUrl).host;
            showNotice(shotFailed ? `📝 筆記已存 (${portLabel})，但截圖上傳失敗` : `📝 筆記已存進 Web Library！(${portLabel})`);
            GM_setValue(WL_NOTE_DRAFT_KEY, JSON.stringify({ title: "", content: "", shot: wlNoteUi.shot.checked }));
            wlNoteUi.title.value = "";
            wlNoteUi.content.value = "";
            wlNoteUi.save.disabled = false;
            wlNoteHost.style.display = "none";
            return;
        }

        // 所有伺服器都連不上：草稿保留在記事本裡，另把筆記 JSON (不含截圖) 複製到剪貼簿
        wlNoteUi.save.disabled = false;
        wlNoteUi.status.textContent = "伺服器未開啟，草稿已保留";
        try { navigator.clipboard.writeText(JSON.stringify(payload)); } catch (e) {}
        showNotice("✨ 伺服器未開啟，筆記草稿已保留並複製到剪貼簿，開啟伺服器後再按一次存檔即可。");
    }

    // 記事本快捷鍵：Alt + N 開關 (限定只按 Alt+N，不含 Ctrl/Shift/Meta，避免誤觸其他組合)；
    // 記事本開著時按 Esc 關閉。同樣用捕獲階段 (最後的 true) 搶在網頁之前處理。
    window.addEventListener("keydown", (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyN") {
            e.preventDefault();
            e.stopPropagation();
            wlNoteToggle();
        } else if (e.key === "Escape" && wlNoteIsOpen()) {
            e.preventDefault();
            e.stopPropagation();
            wlNoteClose();
        }
    }, true);

    // Tampermonkey 選單也加入「開啟快捷記事本」，不方便按快捷鍵時可用
    if (typeof GM_registerMenuCommand !== "undefined") {
        GM_registerMenuCommand("開啟快捷記事本 (Alt+N)", wlNoteToggle);
    }



    /**
     * 掛載懸浮球的入口函式。
     * 觸發時機：頁面載入完成、單頁應用換頁、以及每 2.5 秒定時檢查 (下方註冊)。
     */
    // 9. 掛載懸浮球

    function setupTrigger() {

        createDraggableFAB();

    }



    // 若頁面已經載入完就直接掛上懸浮球，否則等 DOMContentLoaded 事件再掛
    if (document.readyState === "complete" || document.readyState === "interactive") {

        setupTrigger();

    } else {

        document.addEventListener("DOMContentLoaded", setupTrigger);

    }



    // YouTube、Bilibili 這類單頁應用換頁時不會重新載入整頁，懸浮球可能被網站清掉。
    // 所以監聽 YouTube 換頁事件 (yt-navigate-finish)、瀏覽器上一頁 (popstate)，
    // 再加上每 2.5 秒定時檢查一次，確保懸浮球消失時能自動補回來。
    window.addEventListener("yt-navigate-finish", setupTrigger);

    window.addEventListener("popstate", setupTrigger);

    setInterval(setupTrigger, 2500);



})();

