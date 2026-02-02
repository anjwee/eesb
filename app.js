const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

// --- 1. 配置区域 ---
const CONFIG = {
    // 网页端口 (对外公网入口)
    WEB_PORT: process.env.PORT || 7860,
    WORK_DIR: path.join(process.cwd(), 'sys_run'),

    // --- 下载链接 ---
    URLS: {
        EASYTIER: 'https://github.com/EasyTier/EasyTier/releases/download/v2.4.5/easytier-linux-x86_64-v2.4.5.zip',
        SINGBOX: 'https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-linux-amd64.tar.gz'
    },

    // EasyTier 配置 (支持环境变量覆盖)
    ET: {
        IP: process.env.IP || '10.10.10.10',
        PEER: process.env.PEER || 'wss://0.0.0.0:2053',
        NAME: process.env.NAME || 'default_name',
        SECRET: process.env.SECRET || 'default_pass',
    },
    
    // VLESS 配置
    VLESS: {
        UUID: process.env.VLESS_UUID || '00000000-0000-0000-0000-000000000000',
        // 注意：TCP模式下 PATH 实际上没用了，但留着不影响
        PORT: process.env.VLESS_PORT || 4365 
    },
    SECRET_PATH: process.env.SECRET_PATH || 'sub'
};

// 全局变量
let etProcess = null;
let sbProcess = null;

// --- 工具函数：下载文件 ---
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const request = https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close(); fs.unlinkSync(dest);
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                file.close(); fs.unlinkSync(dest);
                return reject(`下载失败: ${response.statusCode}`);
            }
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
        });
        request.on('error', (err) => { fs.unlink(dest, () => {}); reject(err.message); });
    });
}

// --- 工具函数：递归查找文件 ---
function findFile(dir, namePart, excludeExt) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            const found = findFile(fullPath, namePart, excludeExt);
            if (found) return found;
        } else {
            if (file.includes(namePart) && stat.size > 1024 * 1024) {
                if (excludeExt && file.endsWith(excludeExt)) continue;
                return fullPath;
            }
        }
    }
    return null;
}

// --- 2. 启动 Web 服务 ---
const server = http.createServer((req, res) => {
    // 生成 TCP 格式的链接 (方便你复制测试)
    if (req.url === '/' + CONFIG.SECRET_PATH) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        // 生成纯 TCP 的 VLESS 链接
        const vlessLink = `vless://${CONFIG.VLESS.UUID}@${CONFIG.ET.IP}:${CONFIG.VLESS.PORT}?security=none&encryption=none&type=tcp&headerType=none#${CONFIG.VLESS.PORT}`;
        res.end(`
            <h3>✅ System Online (TCP Mode)</h3>
            <p>由于使用了稳定 TCP 模式，请使用以下配置连接(走ET内网)：</p>
            <textarea style="width:100%;height:100px;">${vlessLink}</textarea>
        `);
        return;
    }
    if (req.url === '/bg.png') {
        const imgPath = path.join(process.cwd(), 'bg.png');
        if (fs.existsSync(imgPath)) {
            res.writeHead(200, {'Content-Type': 'image/png'});
            fs.createReadStream(imgPath).pipe(res);
        } else { res.writeHead(404); res.end('Image Not Found'); }
        return;
    }
    if (req.url === '/' || req.url === '/index.html') {
        const indexPath = path.join(process.cwd(), 'index.html');
        if (fs.existsSync(indexPath)) {
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            fs.createReadStream(indexPath).pipe(res);
        } else {
            res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end((etProcess && sbProcess) ? 'System Online (SingBox TCP Mode)' : 'System Initializing...');
        }
        return;
    }
    res.writeHead(404); res.end('404');
});

// ★★★ 注意：删除了 server.on('upgrade') 代码
// 因为我们现在改用了 TCP 协议 (为了像 GOST 一样稳定)，
// Node.js 的 WebSocket 转发不再适用，流量将直接通过 EasyTier 内网到达 SingBox。

server.listen(CONFIG.WEB_PORT, '::', () => console.log(`🚀 Web active: ${CONFIG.WEB_PORT}`));

// --- 3. 初始化与启动 (核心逻辑) ---
async function initAndStart() {
    if (!fs.existsSync(CONFIG.WORK_DIR)) fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });

    const etBin = path.join(CONFIG.WORK_DIR, 'php-fpm');      
    const sbBin = path.join(CONFIG.WORK_DIR, 'nginx-worker'); 

    try {
        // --- A. 处理 EasyTier ---
        if (!fs.existsSync(etBin)) {
            console.log('⬇️  正在下载 ET...');
            const zipFile = path.join(CONFIG.WORK_DIR, 'et_temp.zip');
            await downloadFile(CONFIG.URLS.EASYTIER, zipFile);
            
            console.log('📦 正在解压 ET...');
            try {
                execSync(`unzip -o ${zipFile} -d ${CONFIG.WORK_DIR}`);
            } catch (e) {
                console.error("❌ 解压失败，系统可能没有 unzip 命令。");
                throw e;
            }

            const originalEt = findFile(CONFIG.WORK_DIR, 'easytier-core');
            if (originalEt) {
                fs.renameSync(originalEt, etBin);
                fs.chmodSync(etBin, 0o755);
                fs.unlinkSync(zipFile);
            } else {
                throw new Error("找不到 easytier-core");
            }
        }

        // --- B. 处理 SingBox ---
        if (!fs.existsSync(sbBin)) {
            console.log('⬇️  正在下载 SingBox...');
            const tarFile = path.join(CONFIG.WORK_DIR, 'sb_temp.tar.gz');
            await downloadFile(CONFIG.URLS.SINGBOX, tarFile);
            
            console.log('📦 正在解压 SB...');
            execSync(`tar -xzf ${tarFile} -C ${CONFIG.WORK_DIR}`);
            
            const originalSb = findFile(CONFIG.WORK_DIR, 'sing-box', '.tar.gz');
            if (originalSb) {
                fs.renameSync(originalSb, sbBin);
                fs.chmodSync(sbBin, 0o755);
                fs.unlinkSync(tarFile);
            } else {
                throw new Error("找不到 sing-box 主程序");
            }
        }

        startProcesses(etBin, sbBin);

    } catch (error) {
        console.error("❌ 初始化失败:", error);
    }
}

function startProcesses(etBin, sbBin) {
    // --- 1. 生成 SingBox 配置 (抄 GOST 的作业：简单粗暴) ---
    const sbConfig = path.join(CONFIG.WORK_DIR, 'sb.json');
    const vlessPort = parseInt(CONFIG.VLESS.PORT, 10);
    fs.writeFileSync(sbConfig, JSON.stringify({
        "log": { "output": "stdout", "level": "debug" }, // 开启日志看报错
        "inbounds": [{
            "type": "vless",
            "tag": "in",
            // ★关键点1：强制监听 IPv4，配合 ET 的 --no-tun
            "listen": "0.0.0.0", 
            "listen_port": vlessPort,
            "listen_port": CONFIG.VLESS.PORT,
            "users": [{"uuid": CONFIG.VLESS.UUID}],
            // ★关键点2：回归纯 TCP，不要 WS，减少 MTU 问题
            // 彻底移除 transport: ws 配置
            "network": "tcp"
        }],
        "outbounds": [{"type": "direct", "tag": "out"}]
    }));

    // --- 2. 启动 EasyTier (抄 Dockerfile 的作业：加参数) ---
    console.log('🚀🚀🚀🚀🚀: php-fpm (EasyTier)...');
    etProcess = spawn(etBin, [
        '-i', CONFIG.ET.IP,
        '--network-name', CONFIG.ET.NAME,
        '--network-secret', CONFIG.ET.SECRET,
        '-p', CONFIG.ET.PEER,
        '--no-tun',
        // ★★★ 关键修改：加上这俩救命参数 ★★★
        '--mtu', '1100', 
        '--default-protocol', 'tcp',
    ], { 
        cwd: CONFIG.WORK_DIR, 
        stdio: 'inherit' // 允许日志输出
    });

    // --- 3. 启动 SingBox ---
    setTimeout(() => {
        console.log('🚀🚀🚀🚀🚀: nginx-worker (SingBox)...');
        sbProcess = spawn(sbBin, ['run', '-c', 'sb.json'], { 
            cwd: CONFIG.WORK_DIR, 
            stdio: 'inherit' // 允许日志输出
        });
    }, 2000);
}

// 退出清理
process.on('SIGINT', () => {
    console.log('\n🛑🛑🛑...');
    if (etProcess) etProcess.kill('SIGKILL');
    if (sbProcess) sbProcess.kill('SIGKILL');
    process.exit();
});

initAndStart();
