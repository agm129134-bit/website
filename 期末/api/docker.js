/**
 * Docker 控制模組 - 提供前端一鍵部署、啟動、關閉、重啟與移除容器 API
 * 顯式指定 -p web-library 專案名稱，徹底杜絕 Windows 中文目錄名 (期末) 引發之 "project name must not be empty" 錯誤！
 * 支援容器環境感知 (In-Container Awareness)，優雅處理沙盒隔離與指令指引
 */
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const COMPOSE_BASE = 'docker compose -p web-library';
const IS_IN_CONTAINER = fs.existsSync('/.dockerenv');

function handleDockerRoute(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // GET /api/docker/status
    if (pathname === '/api/docker/status' && req.method === 'GET') {
        // 若當前伺服器本身運行在 Docker 容器內，直接回報容器運作正常
        if (IS_IN_CONTAINER) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                success: true,
                running: true,
                inContainer: true,
                status: '容器運行中 (In Docker)',
                details: '當前 Web Library 服務正於 Docker 容器內部獨立運行 (Node.js 20 Alpine)。'
            }));
        }

        exec('docker ps -a --filter "name=web-library" --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"', { cwd: ROOT_DIR }, (err, stdout, stderr) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({
                    success: false,
                    running: false,
                    status: 'Docker 服務未啟動或未安裝',
                    error: err.message
                }));
            }

            const raw = stdout ? stdout.trim() : '';
            const isRunning = raw.toLowerCase().includes('up');
            const exists = raw.length > 0;

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: true,
                running: isRunning,
                exists: exists,
                status: isRunning ? '運行中 (Running)' : (exists ? '已停止 (Stopped)' : '未建立 (Not Built)'),
                details: raw || '尚未建立 web-library 容器'
            }));
        });
        return;
    }

    // POST /api/docker/action
    if (pathname === '/api/docker/action' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const action = data.action;

                // 若在容器內部發起 Docker 操作，提供安全指引（容器無法自我終結宿主進程）
                if (IS_IN_CONTAINER) {
                    const actionZh = {
                        up: '部署',
                        update: '更新與重新編譯',
                        start: '啟動',
                        stop: '關閉',
                        restart: '重啟',
                        down: '移除'
                    }[action] || action;

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    return res.end(JSON.stringify({
                        success: true,
                        inContainer: true,
                        action: action,
                        command: `docker compose -p web-library ${(action === 'up' || action === 'update') ? 'up -d --build' : action}`,
                        output: `【Docker 安全沙盒提示】\n您當前正是透過此 Docker 容器在瀏覽本網頁。\n依據容器安全隔離標準，容器內部無法反向終止宿主機（Windows）上的 Docker 進程。\n\n如需${actionZh}此容器，請在 Windows 本機終端機中執行：\n  docker compose -p web-library ${(action === 'up' || action === 'update') ? 'up -d --build' : action}\n\n或直接在 Docker Desktop 應用程式介面中點擊 Stop / Restart 按鍵即可。`,
                        error: null
                    }));
                }

                let cmd = '';
                switch (action) {
                    case 'up':
                    case 'update':
                        cmd = `${COMPOSE_BASE} up -d --build`;
                        break;
                    case 'start':
                        cmd = `${COMPOSE_BASE} start`;
                        break;
                    case 'stop':
                        cmd = `${COMPOSE_BASE} stop`;
                        break;
                    case 'restart':
                        cmd = `${COMPOSE_BASE} restart`;
                        break;
                    case 'down':
                        cmd = `${COMPOSE_BASE} down`;
                        break;
                    default:
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        return res.end(JSON.stringify({ success: false, message: '無效的 Docker 操作指令' }));
                }

                exec(cmd, { cwd: ROOT_DIR }, (err, stdout, stderr) => {
                    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
                    const outputMsg = combined || (err ? err.message : '指令已成功派發完成');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: !err,
                        action: action,
                        command: cmd,
                        output: outputMsg,
                        error: err ? err.message : null
                    }));
                });
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: '找不到對應的 Docker API 路由' }));
}

module.exports = { handleDockerRoute };
