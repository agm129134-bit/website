/**
 * api/game-defaults.js
 * 
 * ACG 專區：遊戲專區與工具攻略庫內建預設卡片清單 (8 張)
 * 伺服器初次啟動時由 api/db.js autoMigrate() 自動匯入至 data/games.db (type: 'default')。
 * 每張卡片包含：id、title、url、badge、badgeClass、tags、desc、isCustom: false，部分需另開分頁者包含 openInNewTab: true。
 */
const DEFAULT_ACG_GAMES = [
  {
    id: "game_fgo_chaldea",
    title: "Fate/Grand Order - Chaldea 迦勒底",
    url: "https://chaldea.center/",
    badge: "FGO 官方/開源神器",
    badgeClass: "bg-danger text-white",
    tags: ["FGO", "迦勒底", "素材規劃", "從者養成", "活動周回"],
    desc: "跨平台開源 FGO 規劃工具，支援從者養成計算、素材需求掉落統計、活動周回規劃與抽卡模擬，支援在當前視窗即開即用！",
    isCustom: false,
  },
  {
    id: "game_fgo_mooncell",
    title: "Mooncell Wiki - FGO 繁簡中文百科",
    url: "https://fgo.wiki/",
    badge: "權威百科",
    badgeClass: "bg-primary text-white",
    tags: ["FGO", "中文百科", "指令卡數據", "關卡掉落"],
    desc: "中文圈最詳盡的 Fate/Grand Order 中文資料庫，完整收錄從者數值、指令卡參數、寶具傷害、敵方配置與最新活動攻略。",
    isCustom: false,
  },
  {
    id: "game_mfme_wiki",
    title: "魔法紀錄：魔法少女小圓外傳 - GameKee 攻略百科",
    url: "https://www.gamekee.com/mfme/",
    badge: "Wiki 百科",
    badgeClass: "bg-danger-subtle text-danger border border-danger-subtle",
    tags: ["魔法紀錄", "小圓外傳", "GameKee", "角色圖鑑", "活動攻略"],
    desc: "魔法少女小圓外傳最齊全的中文圖鑑與攻略站，收錄魔法少女養成數據、記憶結晶評價與活動關卡打法。",
    isCustom: false,
  },
  {
    id: "game_madoka_exedra",
    title: "魔法少女小圓 Magia Exedra - Game8 攻略Wiki",
    url: "https://game8.jp/madoka-exedra",
    badge: "新作攻略Wiki",
    badgeClass: "bg-danger text-white",
    tags: ["魔法少女小圓", "Magia Exedra", "Game8", "首抽推薦", "最新攻略"],
    desc: "Game8 官方認證《魔法少女小圓 Magia Exedra》綜合攻略Wiki，提供首抽節奏榜、最強角色養成、活動關卡攻略與最新情報速報。",
    isCustom: false,
  },
  {
    id: "game_adx_charts",
    title: "AstroDX 譜面資源庫 (ADX Charts) - maimai 譜面下載與社群資源",
    url: "https://adxdls.saop.cc/",
    badge: "maimai 譜面庫",
    badgeClass: "bg-primary text-white",
    tags: ["AstroDX", "maimai", "音遊", "街機模擬器", "譜面下載", "ADX Charts"],
    desc: "專為 maimai 模擬器 AstroDX 打造的社群譜面資源庫，收錄數千首社群與官方精選譜面、版本與曲風瀏覽、線上試聽試玩與一鍵匯入導入指南。",
    isCustom: false,
  },
  {
    id: "game_bilibili_fx_toy",
    title: "FX 簡單！(外匯模擬交易) - Bilibili Toy",
    url: "https://www.bilibili.com/toy/fx-simple/index.html",
    badge: "B站小遊戲",
    badgeClass: "bg-info-subtle text-info border border-info-subtle",
    tags: ["Bilibili", "外匯模擬", "趣味挑戰", "互動網頁"],
    desc: "Bilibili Toy 推出之趣味外匯模擬交易小遊戲，輕鬆體驗低買高賣的刺激心跳！",
    isCustom: false,
    openInNewTab: true,
  },
  {
    id: "game_powerful_wind_cabbages",
    title: "強風大背頭",
    url: "https://asyncfish.itch.io/powerful-wind-slicked-back-cabbages",
    badge: "節奏獨立小遊戲",
    badgeClass: "bg-success-subtle text-success border border-success-subtle",
    tags: ["強風大背頭", "節奏", "獨立小遊戲", "Itch.io"],
    desc: "節奏獨立小遊戲。由迷因神曲《強風大背頭》改編的魔性節奏獨立小遊戲，畫風超可愛治癒！",
    isCustom: false,
    openInNewTab: true,
  },
  {
    id: "game_dabuchi_unityroom",
    title: "狂吃雙吉堡 (ダブチを食べまくるゲーム)",
    url: "https://unityroom.com/games/dabuchitabemakurugame",
    badge: "Unity 遊戲",
    badgeClass: "bg-warning-subtle text-warning border border-warning-subtle",
    tags: ["Unityroom", "雙吉堡", "吃漢堡", "休閒挑戰"],
    desc: "日本 Unityroom 熱門小遊戲「ダブチを食べまくるゲーム」（狂吃麥當勞雙層牛肉吉事堡），操控角色爽快狂吃漢堡挑戰最高得分！",
    isCustom: false,
    openInNewTab: true,
  },
];

module.exports = DEFAULT_ACG_GAMES;
