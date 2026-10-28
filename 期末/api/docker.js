/**
 * Docker 控制模組 - 提供前端一鍵部署、啟動、關閉、重啟與移除容器 API
 */
const { exec } = require('child_process');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

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
                        cmd = 'docker compose up -d --build';
                        break;
                    case 'start':
                        cmd = 'docker compose start';
                        break;
                    case 'stop':
                        cmd = 'docker compose stop';
                        break;
                    case 'restart':
                        cmd = 'docker compose restart';
                        break;
                    case 'down':
                        cmd = 'docker compose down';
                        break;
                    default:
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        return res.end(JSON.stringify({ success: false, message: '無效的 Docker 操作指令' }));
                }

                exec(cmd, { cwd: ROOT_DIR }, (err, stdout, stderr) => {
                    const outputMsg = (stdout || stderr || '指令已成功派發完成').trim();
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
