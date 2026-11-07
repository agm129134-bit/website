/**
 * acg.js - ACG 專區獨立模組 (輪播、日曆、GSAP 動態與互動)
 * 供 index.html (SPA 切頁) 與 acg.html (直接載入) 雙向調用，杜絕空白與 F5 依賴
 */

// 整支檔案包在 IIFE（立即執行函式）裡，裡面的變數不會污染全域；需要給 HTML 呼叫的才用 window.xxx = ... 掛出去
(function () {
    // 輪播數量管理 (0 代表全部顯示)
    // ---- 模組內部狀態 ----
    // currentCarouselLimit：輪播最多顯示幾部（5、10 或 0=全部），由上方三顆按鈕切換
    // todayAiringAnimeList：今天播出的動畫清單，輪播從這裡取資料
    let currentCarouselLimit = 0;
    let todayAiringAnimeList = [];

    // 備案資料：第一次造訪又沒網路時，輪播至少還有東西可以顯示（資料寫死在程式裡）
    // 首次造訪且完全離線時的最後備案 (只用到 renderCarouselItems 讀的欄位；網址由 id 組出)
    const FALLBACK_BANGUMI_ITEMS = [
        { id: 466827, name: "ダンダダン", name_cn: "膽大黨 (超自然武裝當噠當)", rating: { score: 8.4 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/d3/99/622288_nmbC3.jpg" },
          summary: "高中女生綾瀨桃因相信幽靈但否認外星人，與相信外星人但否認幽靈的高中男生高倉健相遇，兩人為證明各自所信，展開驚心動魄又爆笑的超自然戰鬥！" },
        { id: 397211, name: "葬送のフリーレン", name_cn: "葬送的芙莉蓮", rating: { score: 8.9 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/5a/36/397211_8lD6P.jpg" },
          summary: "身為精靈族的魔法使芙莉蓮，在勇者一行人打倒魔王之後，開始踏上探索生命意義與人間情感的漫長旅途。" },
        { id: 438180, name: "アオのハコ", name_cn: "青之箱", rating: { score: 7.9 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/40/14/297094_4TUt8.jpg" },
          summary: "男子羽毛球部成員豬俁大喜，暗戀著女子籃球部的學姐鹿野千夏。因為家庭變故，兩人竟然開始了同住一個屋簷下的同居生活！" },
        { id: 443423, name: "【推しの子】第2期", name_cn: "【我推的孩子】第二季", rating: { score: 8.2 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/44/ed/634210_O7aNK.jpg" },
          summary: "深入演藝圈舞台劇《東京BLADE》的排練現場，阿奎亞與黑川茜、有馬加奈等人展開演技與內心創傷的交鋒。" },
        { id: 364450, name: "ぼっち・ざ・ろっく！", name_cn: "孤獨搖滾！", rating: { score: 8.8 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/b6/e8/590553_Xz5PO.jpg" },
          summary: "極度怕生又喜愛吉他的孤獨少女後藤一里，在某天被伊地知虹夏邀請加入「結束樂隊」，展開了從未體驗過的樂團青春生活。" },
        { id: 393962, name: "ダンジョン飯", name_cn: "迷宮飯", rating: { score: 8.3 },
          images: { large: "https://lain.bgm.tv/pic/cover/l/c7/ab/688838_jAPXY.jpg" },
          summary: "在迷宮深處被炎龍吞食妹妹的萊歐斯隊伍，為了盡快救回妹妹，展開了以魔物為食材自給自足的奇妙迷宮美食冒險！" }
    ];

    /**
     * 切換輪播顯示數量，由頁面上「全部 / 10 / 5」按鈕的 onclick 呼叫
     * @param {number} limit 要顯示的數量，0 代表全部
     * 作法：先把三顆按鈕都恢復成未選取樣式，再把目前選到的那顆標成深色，最後重畫輪播
     */
    // 輪播數量切換按鈕控制
    window.setCarouselDisplayLimit = function (limit) {
        currentCarouselLimit = limit;
        document.querySelectorAll('#btnShowAll, #btnShow10, #btnShow5').forEach(b => {
            b.classList.remove('btn-dark', 'active');
            b.classList.add('btn-outline-secondary');
        });
        const activeBtn = limit === 5 ? document.getElementById('btnShow5') : (limit === 10 ? document.getElementById('btnShow10') : document.getElementById('btnShowAll'));
        if (activeBtn) {
            activeBtn.classList.remove('btn-outline-secondary');
            activeBtn.classList.add('btn-dark', 'active');
        }
        renderCarouselItems();
    };

    // ---- Bangumi 放送時間表（動畫每週播出表）----
    // 為什麼要寫這麼多層備援？因為外部 API 可能連不上，網頁不能因此變空白。
    // 順序：記憶體 -> 24 小時快取 -> 官方 API -> CORS 代理 -> 過期快取 -> 寫死的精選清單
    // 多通道 Bangumi 時間表請求：24h 快取 -> 官方直連 -> CORS 代理 -> 過期快取 -> 精選離線清單
    const BGM_CALENDAR_URL = "https://api.bgm.tv/calendar";
    const CAL_CACHE_KEY = "web_library_bgm_calendar_cache";
    const CAL_CACHE_TTL = 24 * 60 * 60 * 1000;

    /**
     * 讀取 sessionStorage 裡的時間表快取
     * @returns {{ts:number, data:Array}|null} 有效快取物件；沒有或格式壞掉就回傳 null
     * try/catch 是因為 JSON 壞掉或瀏覽器禁用儲存時會丟錯，不能讓它影響整個頁面
     */
    function readCalendarCache() {
        try {
            const parsed = JSON.parse(sessionStorage.getItem(CAL_CACHE_KEY));
            return Array.isArray(parsed?.data) && parsed.data.length ? parsed : null;
        } catch (e) { return null; }
    }

    /**
     * 用 fetch 向指定網址抓時間表 JSON（非同步）
     * @param {string} url API 網址
     * @returns {Promise<Array|null>} 成功回傳非空陣列，失敗或逾時回傳 null
     * AbortSignal.timeout(3500)：3.5 秒沒回應就放棄，免得使用者一直等
     */
    // 3.5s 超時，回傳非空陣列或 null
    async function fetchCalendarJson(url) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
            const data = res.ok ? await res.json() : null;
            return Array.isArray(data) && data.length ? data : null;
        } catch (e) {
            console.warn("Bangumi 時間表通道失敗:", url, e);
            return null;
        }
    }

    /**
     * 把選定的資料存成全域資料，讓別的檔案（例如日曆切換）也能讀取
     * @param {Array} data 時間表資料
     * @param {boolean} isFallback 是否為備援資料（true 時輪播會顯示「點此重試」）
     * @returns {Array} 原樣回傳 data，方便呼叫端直接 return
     */
    function useCalendar(data, isFallback) {
        window.bangumiCalendarData = data;
        window._isUsingFallbackBangumi = isFallback;
        return data;
    }

    /**
     * 取得時間表的主要函式：依序嘗試多個來源，保證一定回傳資料
     * @param {boolean} force 是否強制重新連線（忽略記憶體與快取），「點此重試」會傳 true
     * @returns {Promise<Array>} 以星期分組的放送資料
     */
    async function fetchCalendarDataWithFallback(force = false) {
        // 已經載入過而且不是強制重抓，就直接用記憶體裡的資料
        if (!force && window.bangumiCalendarData?.length) return window.bangumiCalendarData;

        // 24 小時內的快取還新鮮，直接用，省得每次進頁面都打 API
        const cache = readCalendarCache();
        if (!force && cache && Date.now() - cache.ts < CAL_CACHE_TTL) return useCalendar(cache.data, false);

        // 先打官方 API，失敗再透過 allorigins 這個 CORS 代理（有些網路環境直連會被擋）；|| 代表前一個回傳 null 才試下一個
        const live = await fetchCalendarJson(BGM_CALENDAR_URL)
            || await fetchCalendarJson("https://api.allorigins.win/raw?url=" + encodeURIComponent(BGM_CALENDAR_URL));
        // 抓成功：存進快取（存不下就忽略），並回傳最新資料
        if (live) {
            try { sessionStorage.setItem(CAL_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: live })); } catch (e) { }
            return useCalendar(live, false);
        }

        // 全部通道都失敗的最後手段（見下面註解）
        // 連不上時：上次成功的資料 (即使過期) 比寫死的清單準；都沒有才只在今天那欄放精選清單
        if (cache) return useCalendar(cache.data, true);
        // getDay() 週日是 0，這裡轉成 7，對應 Bangumi 的 weekday.id（1=週一 ... 7=週日）
        const today = new Date().getDay() || 7;
        return useCalendar([1, 2, 3, 4, 5, 6, 7].map(id => ({
            weekday: { id },
            items: id === today ? FALLBACK_BANGUMI_ITEMS : []
        })), true);
    }
    // 掛到 window，讓其他 script（如 acg.html 內嵌的日曆程式）可以呼叫
    window.fetchCalendarDataWithFallback = fetchCalendarDataWithFallback;

    /**
     * 載入並畫出「今日新番」輪播
     * @param {boolean} force 是否強制重新連線
     * 觸發時機：頁面載入完成（DOMContentLoaded）、或點「點此重試連線」
     */
    // 輪播圖動態載入 (100% 容錯防崩)
    async function initAcgPageCarousel(force = false) {
        const dateTextEl = document.getElementById("carouselDateText");
        try {
            // await：等時間表抓回來再往下做（非同步流程）
            const data = await fetchCalendarDataWithFallback(force);
            const today = new Date().getDay() || 7;
            // 從整週資料中找出「今天」那一天的資料
            const dayData = (data && Array.isArray(data)) ? data.find(d => d.weekday && d.weekday.id === today) : null;
            const weekdayNames = { 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日' };
            // 今天沒資料就用備案清單，避免輪播空白
            todayAiringAnimeList = dayData && dayData.items ? dayData.items : FALLBACK_BANGUMI_ITEMS;

            const totalCount = todayAiringAnimeList.length;
            // 更新輪播上方的日期說明文字；備援模式時多放一顆可點擊的重試徽章（onclick 呼叫下面掛到 window 的函式）
            if (dateTextEl) {
                if (window._isUsingFallbackBangumi) {
                    dateTextEl.innerHTML = `今天是 ${weekdayNames[today]} · 熱播精選推薦 (${totalCount} 部) <span class="badge bg-secondary-subtle text-white-50 ms-2" role="button" onclick="initAcgPageCarousel(true)" title="點擊重新連線 Bangumi"><i class="bi bi-arrow-clockwise"></i> 點此重試連線</span>`;
                } else {
                    dateTextEl.textContent = `今天是 ${weekdayNames[today]} · 本日共播出 ${totalCount} 部新番`;
                }
            }

            // 資料就緒，把動畫卡片畫成輪播投影片
            renderCarouselItems();
        // 任何一步出錯都改用備案清單，確保輪播不會壞掉
        } catch (e) {
            console.error("載入輪播失敗，啟用離線精選新番", e);
            todayAiringAnimeList = FALLBACK_BANGUMI_ITEMS;
            renderCarouselItems();
        }
    }
    // 掛到 window 讓上面 HTML 字串裡的 onclick 找得到這個函式
    window.initAcgPageCarousel = initAcgPageCarousel;

    /**
     * 依照 todayAiringAnimeList 與 currentCarouselLimit 動態產生輪播的每一張投影片與下方小圓點
     * 沒有參數、沒有回傳值；每次切換數量或重新載入都會整個重畫
     */
    function renderCarouselItems() {
        if (!todayAiringAnimeList || todayAiringAnimeList.length === 0) return;

        // 限制數量（slice 取前 N 筆）；limit 為 0 時全部顯示
        const displayItems = currentCarouselLimit > 0 ? todayAiringAnimeList.slice(0, currentCarouselLimit) : todayAiringAnimeList;
        const inner = document.getElementById("carouselInner");
        const indicators = document.getElementById("carouselIndicators");
        if (!inner || !indicators) return;

        // 先清空舊內容再重建
        inner.innerHTML = "";
        indicators.innerHTML = "";

        // 防 XSS：動畫名稱、簡介來自外部 API，塞進 innerHTML 前必須把 < > & " 轉成安全字元；優先用全域的 escapeHtml
        const escapeHtml = window.escapeHtml || function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };

        // 每部動畫產生一個小圓點 (indicator) 與一張投影片 (carousel-item)
        displayItems.forEach((anime, idx) => {
            const title = anime.name_cn || anime.name;
            // 封面圖依序找 large -> common -> medium，都沒有就用預設圖
            let cover = anime.images?.large || anime.images?.common || anime.images?.medium || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1000&q=80";
            // 把 http 換成 https，避免 https 頁面載入 http 圖片被瀏覽器擋（混合內容）
            cover = cover.replace(/^http:\/\//i, "https://");
            const score = anime.rating && anime.rating.score ? `⭐ ${anime.rating.score.toFixed(1)} 評分` : "熱播新番";
            // 優先用 API 給的網址，沒有就用動畫 id 自己組出 Bangumi 條目頁
            const bgmUrl = anime.url ? anime.url.replace(/^http:\/\//i, "https://") : `https://bgm.tv/subject/${anime.id}`;

            // Indicator
            const ind = document.createElement("button");
            ind.type = "button";
            ind.setAttribute("data-bs-target", "#acgTodayCarousel");
            ind.setAttribute("data-bs-slide-to", idx.toString());
            ind.setAttribute("aria-label", `Slide ${idx + 1}`);
            if (idx === 0) {
                ind.className = "active";
                ind.setAttribute("aria-current", "true");
            }
            indicators.appendChild(ind);

            // Item
            const item = document.createElement("div");
            item.className = `carousel-item acg-carousel-item ${idx === 0 ? 'active' : ''}`;
            // 投影片內容：背景圖、海報、評分、標題、簡介，以及「播放來源」與「收藏至圖書館」兩顆按鈕（onclick 會呼叫 acg.html 裡定義的函式）
            item.innerHTML = `
                <img src="${cover}" class="acg-carousel-bg" alt="bg">
                <div class="acg-carousel-content gap-4">
                    <img src="${cover}" class="acg-poster-img" alt="${escapeHtml(title)}">
                    <div class="d-flex flex-column align-items-start">
                        <span class="badge bg-warning text-dark mb-2">${score}</span>
                        <h2 class="fw-bold mb-2 text-white">${escapeHtml(title)}</h2>
                        <p class="text-white-50 small mb-4 text-truncate-2" style="max-width: 600px;">
                            ${escapeHtml(anime.summary || "暫無番劇詳細簡介，今日火熱放送中。")}
                        </p>
                        <div class="d-flex gap-2">
                            <button class="btn btn-danger px-4 rounded-pill shadow-sm" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" onclick="openKazumiFromElement(this)">
                                <i class="bi bi-broadcast"></i> 播放來源與觀看
                            </button>
                            <button class="btn btn-outline-light px-4 rounded-pill shadow-sm" data-title="${escapeHtml(title)}" data-url="${escapeHtml(bgmUrl)}" data-cover="${escapeHtml(cover)}" onclick="collectBangumiFromElement(this)">
                                <i class="bi bi-bookmark-plus"></i> 收藏至圖書館
                            </button>
                        </div>
                    </div>
                </div>
            `;
            inner.appendChild(item);
        });

        // 重新初始化 Bootstrap Carousel，確保非同步載入後自動輪播與滑動控制正常生效
        const carouselEl = document.getElementById("acgTodayCarousel");
        if (carouselEl && window.bootstrap && window.bootstrap.Carousel) {
            const inst = bootstrap.Carousel.getInstance(carouselEl);
            if (inst) inst.dispose();
            const bsCarousel = new bootstrap.Carousel(carouselEl, {
                interval: 4000,
                ride: 'carousel',
                wrap: true,
                touch: true
            });
            bsCarousel.cycle();

            // GSAP 輪播換頁文字滑入動效
            if (!carouselEl.dataset.gsapBound) {
                carouselEl.dataset.gsapBound = "true";
                carouselEl.addEventListener('slid.bs.carousel', () => {
                    const activeContent = carouselEl.querySelector('.carousel-item.active .acg-carousel-content');
                    if (activeContent && typeof gsap !== 'undefined') {
                        gsap.fromTo(activeContent,
                            { opacity: 0, x: 8 },
                            { opacity: 1, x: 0, duration: 0.25, ease: "power2.out", clearProps: "transform,opacity" }
                        );
                    }
                });
            }
        }
    }
    window.renderCarouselItems = renderCarouselItems;

    /**
     * 載入下方的「每週放送日曆」
     * @param {boolean} force 是否強制重新連線
     * 先確保資料已抓到，再呼叫 switchCalendarWeekday（定義在 acg.html）切到今天那一天
     */
    // 下方日曆載入 (全面使用多通道 fallback)
    async function loadAcgPageCalendar(force = false) {
        const today = new Date().getDay() || 7;
        try {
            await fetchCalendarDataWithFallback(force);
            // switchCalendarWeekday 由 acg.html 另一段 script 提供，有可能還沒載入，所以先檢查
            if (typeof window.switchCalendarWeekday === 'function') {
                window.switchCalendarWeekday(today);
            } else {
                // 還沒準備好就等 0.2 秒再試一次
                setTimeout(() => {
                    if (typeof window.switchCalendarWeekday === 'function') {
                        window.switchCalendarWeekday(today);
                    }
                }, 200);
            }
        } catch (e) {
            // 失敗時在日曆區顯示錯誤訊息與重試連結
            console.error("載入時間表失敗", e);
            const grid = document.getElementById("bangumiAnimeGrid");
            if (grid) grid.innerHTML = `<div class="col-12 text-center text-muted py-4">連線 Bangumi 取得放送數據失敗，<a href="javascript:void(0)" onclick="loadAcgPageCalendar(true)">點此重試</a></div>`;
        }
    }
    // 掛到 window 讓錯誤訊息裡的 onclick 能呼叫
    window.loadAcgPageCalendar = loadAcgPageCalendar;

    // ---- GSAP 動畫區（GSAP 是第三方動畫函式庫）----
    // GSAP 動態管理與懸浮微互動
    // 記住開場動畫的時間軸，重複進入頁面時可以先還原
    let acgIntroTl = null;

    /**
     * 初始化頁面所有動畫與互動：開場淡入、卡片懸浮、彈窗展開、日曆卡片入場、書架彈窗綁定
     * 沒有參數與回傳值；頁面載入完成時呼叫一次
     * 各處的 dataset.xxxBound 是「已綁定」標記，避免重複進入頁面時事件被綁兩次
     */
    function initAcgGsapAnimations() {
        // 沒載入 GSAP 就直接略過，頁面功能不受影響
        if (typeof gsap === 'undefined') return;

        // 1. 開場時間軸：短距離淡入、不彈跳。SPA 來回切換重複呼叫時先還原上一次，避免元素卡在半透明
        if (acgIntroTl) acgIntroTl.revert();
        const tl = gsap.timeline({ defaults: { ease: "power2.out", duration: 0.3, clearProps: "transform,opacity" } });
        acgIntroTl = tl;

        // 焦點推薦輪播 Banner 區塊淡入
        if (document.querySelector(".acg-carousel-container")) {
            tl.from(".acg-carousel-container, section.mb-4 > .d-flex", {
                y: 8,
                opacity: 0
            });
        }

        // 四大核心卡片依序淡入
        if (document.querySelector(".acg-feature-card")) {
            tl.from(".acg-feature-card", {
                y: 8,
                opacity: 0,
                stagger: 0.05
            }, "-=0.15");
        }

        // 最近觀看紀錄與下方時間表平滑滑入
        if (document.querySelector("#acgWatchHistorySection, section:has(#bangumiAnimeGrid)")) {
            tl.from("#acgWatchHistorySection, section:has(#bangumiAnimeGrid)", {
                y: 8,
                opacity: 0,
                stagger: 0.06
            }, "-=0.15");
        }

        // 2. 四大核心卡片懸浮微互動 (Hover 浮起、圖標微旋轉、按鈕彈力反饋)
        document.querySelectorAll('.acg-feature-card').forEach(card => {
            if (card.dataset.gsapHoverBound) return;
            card.dataset.gsapHoverBound = "true";

            const btn = card.querySelector('.btn');

            card.addEventListener('mouseenter', () => {
                // 極簡：只輕微上浮，邊框與陰影交給 CSS :hover
                gsap.to(card, { y: -2, duration: 0.2, ease: "power2.out" });
            });

            card.addEventListener('mouseleave', () => {
                gsap.to(card, { y: 0, duration: 0.2, ease: "power2.out", clearProps: "transform" });
            });

            if (btn) {
                btn.addEventListener('mousedown', () => {
                    gsap.to(btn, { scale: 0.98, duration: 0.1, ease: "power2.out" });
                });
                ['mouseup', 'mouseleave'].forEach(evt => btn.addEventListener(evt, () => {
                    gsap.to(btn, { scale: 1, duration: 0.15, ease: "power2.out" });
                }));
            }
        });

        // 3. 所有彈窗 (Modals) 開啟時的 GSAP 彈性展開動效
        document.querySelectorAll('.modal').forEach(modal => {
            if (modal.dataset.gsapModalBound) return;
            modal.dataset.gsapModalBound = "true";
            modal.addEventListener('show.bs.modal', () => {
                const dialog = modal.querySelector('.modal-dialog');
                if (dialog) {
                    gsap.fromTo(dialog,
                        { opacity: 0, y: 8 },
                        { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" }
                    );
                }
            });
        });

        // 4. 監聽日曆放送卡片更新，動態加入 stagger 入場效果
        const gridEl = document.getElementById("bangumiAnimeGrid");
        if (gridEl && !gridEl.dataset.observerBound) {
            gridEl.dataset.observerBound = "true";
            const observer = new MutationObserver(() => {
                const cards = gridEl.querySelectorAll('.col-6');
                if (cards.length > 0 && typeof gsap !== 'undefined') {
                    // fromTo + clearProps：連續重繪時不會把卡片卡在半透明
                    gsap.fromTo(cards, { opacity: 0, y: 8 }, {
                        opacity: 1,
                        y: 0,
                        duration: 0.25,
                        stagger: Math.min(0.02, 0.3 / cards.length),
                        ease: "power2.out",
                        clearProps: "transform,opacity"
                    });
                }
            });
            observer.observe(gridEl, { childList: true });
        }

        // 5. 條漫與小說書架 Modal 渲染綁定
        const mangaModal = document.getElementById("mangaReaderModal");
        if (mangaModal && !mangaModal.dataset.bookshelfBound) {
            mangaModal.dataset.bookshelfBound = "true";
            mangaModal.addEventListener('shown.bs.modal', () => {
                if (typeof window.renderMangaBookshelf === 'function') {
                    window.renderMangaBookshelf();
                }
            });
        }

        const novelModal = document.getElementById("novelReaderModal");
        if (novelModal && !novelModal.dataset.bookshelfBound) {
            novelModal.dataset.bookshelfBound = "true";
            novelModal.addEventListener('shown.bs.modal', () => {
                if (typeof window.renderNovelBookshelf === 'function') {
                    window.renderNovelBookshelf();
                }
            });
        }
    }
    window.initAcgGsapAnimations = initAcgGsapAnimations;

    /**
     * 全域視覺效果：滑鼠聚光燈（Spotlight）與書架垃圾桶的顯示控制
     * 原理：滑鼠靠近卡片時，把滑鼠相對卡片的座標寫進 CSS 變數 --mouse-x / --mouse-y，CSS 再用它畫出光暈
     */
    // 全域 Spotlight 游標跟隨與立體垃圾桶初始化
    function initAcgGlobalEffects() {
        // ticking + requestAnimationFrame：節流，每個畫面影格最多算一次，避免滑鼠移動太頻繁造成卡頓
        let ticking = false;
        document.addEventListener('pointermove', (e) => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                // 找出所有需要聚光燈效果的卡片
                const cards = document.querySelectorAll('.spotlight-card, .border-glow, .acg-feature-card, .card');
                cards.forEach(card => {
                    const rect = card.getBoundingClientRect();
                    // 滑鼠在卡片範圍外 40px 以內就算靠近
                    if (
                        e.clientX >= rect.left - 40 &&
                        e.clientX <= rect.right + 40 &&
                        e.clientY >= rect.top - 40 &&
                        e.clientY <= rect.bottom + 40
                    ) {
                        card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                        card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
                    }
                });
                ticking = false;
            });
        });

        // 垃圾桶 Modal 聯動：漫畫/小說書架彈窗關閉時隱藏垃圾桶，開啟時交給 updateBookshelfTrashVisibility 決定要不要顯示
        // 垃圾桶 Modal 聯動
        ['mangaReaderModal', 'novelReaderModal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal && !modal.dataset.trashBound) {
                modal.dataset.trashBound = "true";
                modal.addEventListener('hidden.bs.modal', () => {
                    const trash = document.getElementById("globalBookshelfTrashBin");
                    if (trash) trash.style.display = "none";
                });
                modal.addEventListener('shown.bs.modal', () => {
                    if (typeof window.updateBookshelfTrashVisibility === 'function') {
                        window.updateBookshelfTrashVisibility();
                    }
                });
            }
        });
    }

    // 當原生載入 acg.html 時自動啟動
    // DOMContentLoaded：HTML 解析完才執行，確保 getElementById 找得到元素
    // 當原生載入 acg.html 時自動啟動
    document.addEventListener("DOMContentLoaded", () => {
        initAcgGlobalEffects();
        if (document.getElementById("acgTodayCarousel") || window.location.pathname.includes("acg.html")) {
            initAcgPageCarousel();
            loadAcgPageCalendar();
            initAcgGsapAnimations();
            // 從伺服器同步書架資料（函式定義在別的檔案，存在才呼叫）
            if (typeof window.syncBookshelfFromServer === 'function') {
                window.syncBookshelfFromServer();
            }
        }
    });
})();
