/**
 * Docker 控制模組 - 提供前端一鍵部署、啟動、關閉、重啟與移除容器 API
 * 顯式指定 -p web-library 專案名稱，徹底杜絕 Windows 中文目錄名 (期末) 引發之 "project name must not be empty" 錯誤！
 */
const { exec } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const COMPOSE_BASE = 'docker compose -p web-library';

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
                let cmd = '';

                switch (action) {
                    case 'up':
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
                    // Docker BuildKit 將構建步驟寫入 stderr，屬於正常資訊流；結合 stdout 與 stderr 呈現完整輸出
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
