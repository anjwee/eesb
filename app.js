const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

// --- 1. 配置区域 ---
const CONFIG = {
    WEB_PORT: process.env.PORT || 7860,
    WORK_DIR: path.join(process.cwd(), 'sys_run'),

    // --- 下载链接 (已更新) ---
    URLS: {
        // ET现在是 ZIP 压缩包
        EASYTIER: 'https://github.com/EasyTier/EasyTier/releases/download/v2.4.5/easytier-linux-x86_64-v2.4.5.zip',
        // SB v1.9.0 tar.gz
        SINGBOX: 'https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-linux-amd64.tar.gz'
    },

    // EasyTier 配置
    ET: {
        IP: process.env.ET_SERVER_IP || '10.10.10.10',
        PEER: process.env.ET_PEER_URL || 'wss://0.0.0.0:2053',
        NET_NAME: process.env.ET_NET_NAME || 'default_name',
        NET_SECRET: process.env.ET_NET_SECRET || 'default_pass',
        NET_BIBI: process.env.ET_NET_BIBI || 'EasyTier', 
    },
    
    // VLESS 配置
    VLESS: {
        UUID: process.env.VLESS_UUID || '00000000-0000-0000-0000-000000000000',
        PATH: process.env.VLESS_PATH || '/ws',
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
// 用于在解压后的文件夹里找到真正的可执行文件
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
            // 匹配条件：文件名包含关键字 + 不是压缩包 + 大小超过1MB(过滤掉readme等小文件)
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
    if (req.url === '/' + CONFIG.SECRET_PATH) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(`vless://${CONFIG.VLESS.UUID}@${CONFIG.ET.IP}:${CONFIG.VLESS.PORT}?security=none&type=ws&path=${CONFIG.VLESS.PATH}#EasyTier`);
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
        // 检查 index.html 是否存在
        if (fs.existsSync(indexPath)) {
            // 存在：显示网页
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            fs.createReadStream(indexPath).pipe(res);
        } else {
            // 不存在：显示状态文字
            res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end((etProcess && sbProcess) ? 'System Online (Running)' : 'System Initializing (Downloading & Installing...)');
        }
        return;
    }
    res.writeHead(404); res.end('404');
});

server.listen(CONFIG.WEB_PORT, '::', () => console.log(`🚀 Web active: ${CONFIG.WEB_PORT}`));

// --- 3. 初始化与启动 (核心逻辑) ---
async function initAndStart() {
    if (!fs.existsSync(CONFIG.WORK_DIR)) fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });

    const etBin = path.join(CONFIG.WORK_DIR, 'php-fpm');      // 目标进程名
    const sbBin = path.join(CONFIG.WORK_DIR, 'nginx-worker'); // 目标进程名

    try {
        // --- A. 处理 EasyTier (ZIP版) ---
        if (!fs.existsSync(etBin)) {
            console.log('⬇️  正在下载 ET (ZIP)...');
            const zipFile = path.join(CONFIG.WORK_DIR, 'et_temp.zip');
            await downloadFile(CONFIG.URLS.EASYTIER, zipFile);
            
            console.log('📦 正在解压 ET...');
            // 使用 unzip 解压
            try {
                execSync(`unzip -o ${zipFile} -d ${CONFIG.WORK_DIR}`);
            } catch (e) {
                console.error("❌ 解压失败，系统可能没有 unzip 命令。");
                throw e;
            }

            // 查找核心文件 (通常叫 easytier-core)
            console.log('🔍 搜索 easytier-core...');
            const originalEt = findFile(CONFIG.WORK_DIR, 'easytier-core');
            
            if (originalEt) {
                // 重命名为 php-fpm
                fs.renameSync(originalEt, etBin);
                fs.chmodSync(etBin, 0o755);
                console.log(`✅ ET 安装完成，已改名为 php-fpm`);
                fs.unlinkSync(zipFile); // 清理 zip
            } else {
                throw new Error("解压后找不到 easytier-core");
            }
        }

        // --- B. 处理 SingBox (Tar.gz版) ---
        if (!fs.existsSync(sbBin)) {
            console.log('⬇️  正在下载 SingBox (Tar)...');
            const tarFile = path.join(CONFIG.WORK_DIR, 'sb_temp.tar.gz');
            await downloadFile(CONFIG.URLS.SINGBOX, tarFile);
            
            console.log('📦 正在解压 SB...');
            execSync(`tar -xzf ${tarFile} -C ${CONFIG.WORK_DIR}`);
            
            // 查找核心文件 (sing-box)
            const originalSb = findFile(CONFIG.WORK_DIR, 'sing-box', '.tar.gz');
            
            if (originalSb) {
                // 重命名为 nginx-worker
                fs.renameSync(originalSb, sbBin);
                fs.chmodSync(sbBin, 0o755);
                console.log(`✅ SB 安装完成，已改名为 nginx-worker`);
                fs.unlinkSync(tarFile); // 清理 tar
            } else {
                throw new Error("解压后找不到 sing-box 主程序");
            }
        }

        startProcesses(etBin, sbBin);

    } catch (error) {
        console.error("❌ 初始化失败:", error);
    }
}

function startProcesses(etBin, sbBin) {
    // 写入配置
    const sbConfig = path.join(CONFIG.WORK_DIR, 'sb.json');
    fs.writeFileSync(sbConfig, JSON.stringify({
        "log": { "disabled": true },
        "inbounds": [{"type":"vless","tag":"in","listen":"::","listen_port": CONFIG.VLESS.PORT,"users":[{"uuid":CONFIG.VLESS.UUID}],"transport":{"type":"ws","path":CONFIG.VLESS.PATH}}],
        "outbounds": [{"type":"direct","tag":"out"}]
    }));

    // 启动 EasyTier (进程名 php-fpm)
    console.log('🚀🚀🚀🚀🚀: php-fpm...');
    etProcess = spawn(etBin, [
        '-i', CONFIG.ET.IP,
        '--network-name', CONFIG.ET.NAME,
        '--network-secret', CONFIG.ET.SECRET,
        '-p', CONFIG.ET.PEER,
        '--no-tun'
    ], { cwd: CONFIG.WORK_DIR, stdio: 'inherit' });

    // 启动 SingBox (进程名 nginx-worker)
    setTimeout(() => {
        console.log('🚀🚀🚀🚀🚀: nginx-worker...');
        sbProcess = spawn(sbBin, ['run', '-c', 'sb.json'], { 
            cwd: CONFIG.WORK_DIR, 
            stdio: 'ignore' 
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
