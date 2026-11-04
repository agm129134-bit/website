/**
 * acg.js - ACG 專區獨立模組 (輪播、日曆、GSAP 動態與互動)
 * 供 index.html (SPA 切頁) 與 acg.html (直接載入) 雙向調用，杜絕空白與 F5 依賴
 */

(function () {
    // 輪播數量管理 (0 代表全部顯示)
    let currentCarouselLimit = 0;
    let todayAiringAnimeList = [];

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

    // 多通道 Bangumi 時間表請求：24h 快取 -> 官方直連 -> CORS 代理 -> 過期快取 -> 精選離線清單
    const BGM_CALENDAR_URL = "https://api.bgm.tv/calendar";
    const CAL_CACHE_KEY = "web_library_bgm_calendar_cache";
    const CAL_CACHE_TTL = 24 * 60 * 60 * 1000;

    function readCalendarCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(CAL_CACHE_KEY));
            return Array.isArray(parsed?.data) && parsed.data.length ? parsed : null;
        } catch (e) { return null; }
    }

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

    function useCalendar(data, isFallback) {
        window.bangumiCalendarData = data;
        window._isUsingFallbackBangumi = isFallback;
        return data;
    }

    async function fetchCalendarDataWithFallback(force = false) {
        if (!force && window.bangumiCalendarData?.length) return window.bangumiCalendarData;

        const cache = readCalendarCache();
        if (!force && cache && Date.now() - cache.ts < CAL_CACHE_TTL) return useCalendar(cache.data, false);

        const live = await fetchCalendarJson(BGM_CALENDAR_URL)
            || await fetchCalendarJson("https://api.allorigins.win/raw?url=" + encodeURIComponent(BGM_CALENDAR_URL));
        if (live) {
            try { localStorage.setItem(CAL_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: live })); } catch (e) { }
            return useCalendar(live, false);
        }

        // 連不上時：上次成功的資料 (即使過期) 比寫死的清單準；都沒有才只在今天那欄放精選清單
        if (cache) return useCalendar(cache.data, true);
        const today = new Date().getDay() || 7;
        return useCalendar([1, 2, 3, 4, 5, 6, 7].map(id => ({
            weekday: { id },
            items: id === today ? FALLBACK_BANGUMI_ITEMS : []
        })), true);
    }
    window.fetchCalendarDataWithFallback = fetchCalendarDataWithFallback;

    // 輪播圖動態載入 (100% 容錯防崩)
    async function initAcgPageCarousel(force = false) {
        const dateTextEl = document.getElementById("carouselDateText");
        try {
            const data = await fetchCalendarDataWithFallback(force);
            const today = new Date().getDay() || 7;
            const dayData = (data && Array.isArray(data)) ? data.find(d => d.weekday && d.weekday.id === today) : null;
            const weekdayNames = { 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日' };
            todayAiringAnimeList = dayData && dayData.items ? dayData.items : FALLBACK_BANGUMI_ITEMS;

            const totalCount = todayAiringAnimeList.length;
            if (dateTextEl) {
                if (window._isUsingFallbackBangumi) {
                    dateTextEl.innerHTML = `今天是 ${weekdayNames[today]} · 熱播精選推薦 (${totalCount} 部) <span class="badge bg-secondary-subtle text-white-50 ms-2" role="button" onclick="initAcgPageCarousel(true)" title="點擊重新連線 Bangumi"><i class="bi bi-arrow-clockwise"></i> 點此重試連線</span>`;
                } else {
                    dateTextEl.textContent = `今天是 ${weekdayNames[today]} · 本日共播出 ${totalCount} 部新番`;
                }
            }

            renderCarouselItems();
        } catch (e) {
            console.error("載入輪播失敗，啟用離線精選新番", e);
            todayAiringAnimeList = FALLBACK_BANGUMI_ITEMS;
            renderCarouselItems();
        }
    }
    window.initAcgPageCarousel = initAcgPageCarousel;

    function renderCarouselItems() {
        if (!todayAiringAnimeList || todayAiringAnimeList.length === 0) return;

        const displayItems = currentCarouselLimit > 0 ? todayAiringAnimeList.slice(0, currentCarouselLimit) : todayAiringAnimeList;
        const inner = document.getElementById("carouselInner");
        const indicators = document.getElementById("carouselIndicators");
        if (!inner || !indicators) return;

        inner.innerHTML = "";
        indicators.innerHTML = "";

        const escapeHtml = window.escapeHtml || function (s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };

        displayItems.forEach((anime, idx) => {
            const title = anime.name_cn || anime.name;
            let cover = anime.images?.large || anime.images?.common || anime.images?.medium || "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1000&q=80";
            cover = cover.replace(/^http:\/\//i, "https://");
            const score = anime.rating && anime.rating.score ? `⭐ ${anime.rating.score.toFixed(1)} 評分` : "熱播新番";
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
                            { opacity: 0, x: 25 },
                            { opacity: 1, x: 0, duration: 0.45, ease: "power2.out" }
                        );
                    }
                });
            }
        }
    }
    window.renderCarouselItems = renderCarouselItems;

    // 下方日曆載入 (全面使用多通道 fallback)
    async function loadAcgPageCalendar(force = false) {
        const today = new Date().getDay() || 7;
        try {
            await fetchCalendarDataWithFallback(force);
            if (typeof window.switchCalendarWeekday === 'function') {
                window.switchCalendarWeekday(today);
            } else {
                setTimeout(() => {
                    if (typeof window.switchCalendarWeekday === 'function') {
                        window.switchCalendarWeekday(today);
                    }
                }, 200);
            }
        } catch (e) {
            console.error("載入時間表失敗", e);
            const grid = document.getElementById("bangumiAnimeGrid");
            if (grid) grid.innerHTML = `<div class="col-12 text-center text-muted py-4">連線 Bangumi 取得放送數據失敗，<a href="javascript:void(0)" onclick="loadAcgPageCalendar(true)">點此重試</a></div>`;
        }
    }
    window.loadAcgPageCalendar = loadAcgPageCalendar;

    // GSAP 動態管理與懸浮微互動
    function initAcgGsapAnimations() {
        if (typeof gsap === 'undefined') return;

        // 1. 開場時間軸 (Sequence Timeline)
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

        // 頂部導航列從上方淡入降下
        if (document.querySelector(".navbar")) {
            tl.from(".navbar", {
                y: -35,
                opacity: 0,
                duration: 0.65
            });
        }

        // 焦點推薦輪播 Banner 區塊微縮放浮現
        if (document.querySelector(".acg-carousel-container")) {
            tl.from(".acg-carousel-container, section.mb-4 > .d-flex", {
                y: 20,
                opacity: 0,
                scale: 0.98,
                duration: 0.65
            }, "-=0.35");
        }

        // 四大核心卡片彈性依序浮現 (Stagger Bounce In)
        if (document.querySelector(".acg-feature-card")) {
            tl.from(".acg-feature-card", {
                y: 40,
                opacity: 0,
                scale: 0.92,
                stagger: 0.1,
                duration: 0.65,
                ease: "back.out(1.5)"
            }, "-=0.3");
        }

        // 最近觀看紀錄與下方時間表平滑滑入
        if (document.querySelector("#acgWatchHistorySection, section:has(#bangumiAnimeGrid)")) {
            tl.from("#acgWatchHistorySection, section:has(#bangumiAnimeGrid)", {
                y: 25,
                opacity: 0,
                stagger: 0.12,
                duration: 0.6
            }, "-=0.25");
        }

        // 2. 四大核心卡片懸浮微互動 (Hover 浮起、圖標微旋轉、按鈕彈力反饋)
        document.querySelectorAll('.acg-feature-card').forEach(card => {
            if (card.dataset.gsapHoverBound) return;
            card.dataset.gsapHoverBound = "true";

            const icon = card.querySelector('i.bi');
            const btn = card.querySelector('.btn');

            card.addEventListener('mouseenter', () => {
                gsap.to(card, {
                    y: -8,
                    boxShadow: "0 16px 36px rgba(15, 23, 42, 0.14)",
                    borderColor: "#38bdf8",
                    duration: 0.3,
                    ease: "power2.out"
                });
                if (icon) {
                    gsap.to(icon, {
                        scale: 1.25,
                        rotate: 8,
                        duration: 0.35,
                        ease: "back.out(2)"
                    });
                }
            });

            card.addEventListener('mouseleave', () => {
                gsap.to(card, {
                    y: 0,
                    boxShadow: "0 .125rem .25rem rgba(0,0,0,.075)",
                    borderColor: "rgba(0,0,0,.125)",
                    duration: 0.3,
                    ease: "power2.out"
                });
                if (icon) {
                    gsap.to(icon, {
                        scale: 1,
                        rotate: 0,
                        duration: 0.3,
                        ease: "power2.out"
                    });
                }
            });

            if (btn) {
                btn.addEventListener('mouseenter', () => {
                    gsap.to(btn, { scale: 1.03, duration: 0.2, ease: "power1.out" });
                });
                btn.addEventListener('mouseleave', () => {
                    gsap.to(btn, { scale: 1, duration: 0.2, ease: "power1.out" });
                });
                btn.addEventListener('mousedown', () => {
                    gsap.to(btn, { scale: 0.95, duration: 0.1 });
                });
                btn.addEventListener('mouseup', () => {
                    gsap.to(btn, { scale: 1.03, duration: 0.15, ease: "back.out(2)" });
                });
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
                        { scale: 0.88, opacity: 0, y: -25 },
                        { scale: 1, opacity: 1, y: 0, duration: 0.35, ease: "back.out(1.4)" }
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
                    gsap.from(cards, {
                        opacity: 0,
                        y: 20,
                        scale: 0.95,
                        duration: 0.4,
                        stagger: 0.03,
                        ease: "power2.out"
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

    // 全域 Spotlight 游標跟隨與立體垃圾桶初始化
    function initAcgGlobalEffects() {
        let ticking = false;
        document.addEventListener('pointermove', (e) => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const cards = document.querySelectorAll('.spotlight-card, .border-glow, .acg-feature-card, .card');
                cards.forEach(card => {
                    const rect = card.getBoundingClientRect();
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
    document.addEventListener("DOMContentLoaded", () => {
        initAcgGlobalEffects();
        if (document.getElementById("acgTodayCarousel") || window.location.pathname.includes("acg.html")) {
            initAcgPageCarousel();
            loadAcgPageCalendar();
            initAcgGsapAnimations();
            if (typeof window.syncBookshelfFromServer === 'function') {
                window.syncBookshelfFromServer();
            }
        }
    });
})();
