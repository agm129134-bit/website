/**
 * Web Library 雲端平台主入口 (相容 Render / Vercel / Railway 與本機環境)
 * 自動引導並啟動期末專案 (零外部依賴、純原生 Node.js 架構)
 */
const path = require('path');
const fs = require('fs');

const targetServer = path.join(__dirname, '期末', 'server.js');

if (fs.existsSync(targetServer)) {
    require(targetServer);
} else {
    console.error('❌ 找不到期末專案伺服器檔案:', targetServer);
    process.exit(1);
}
