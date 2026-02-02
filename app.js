const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

const CONFIG = {
    WEB_PORT: process.env.PORT || 7860,
    WORK_DIR: path.join(process.cwd(), 'sys_run'),

    URLS: {
        EASYTIER: 'https://github.com/EasyTier/EasyTier/releases/download/v2.4.5/easytier-linux-x86_64-v2.4.5.zip',
        SINGBOX: 'https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-linux-amd64.tar.gz'
    },

    ET: {
        IP: process.env.IP || '10.10.10.10',
        PEER: process.env.PEER || 'wss://0.0.0.0:2053',
        NAME: process.env.NAME || 'default_name',
        SECRET: process.env.SECRET || 'default_pass',
    },
    
    VLESS: {
        UUID: process.env.VLESS_UUID || '00000000-0000-0000-0000-000000000000',
        PORT: process.env.VLESS_PORT || 4365 
    },
    SECRET_PATH: process.env.SECRET_PATH || 'sub'
};

let etProcess = null;
let sbProcess = null;

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

const server = http.createServer((req, res) => {
    if (req.url === '/' + CONFIG.SECRET_PATH) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
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

server.listen(CONFIG.WEB_PORT, '::', () => console.log(`🚀 Web active: ${CONFIG.WEB_PORT}`));
async function initAndStart() {
    if (!fs.existsSync(CONFIG.WORK_DIR)) fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });

    const etBin = path.join(CONFIG.WORK_DIR, 'php-fpm');      
    const sbBin = path.join(CONFIG.WORK_DIR, 'nginx-worker'); 

    try {
        // --- A. 处理 ET ---
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

        // --- B. 处理 SB ---
        if (!fs.existsSync(sbBin)) {
            console.log('⬇️  正在下载 SB...');
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
    const sbConfig = path.join(CONFIG.WORK_DIR, 'sb.json');
    const vlessPort = parseInt(CONFIG.VLESS.PORT, 10);
    fs.writeFileSync(sbConfig, JSON.stringify({
        "log": { "output": "stdout", "level": "debug" }, 
        "inbounds": [{
            "type": "vless",
            "tag": "in",
            "listen": "0.0.0.0", 
            "listen_port": vlessPort,
            "users": [{"uuid": CONFIG.VLESS.UUID}],
        }],
        "outbounds": [{"type": "direct", "tag": "out"}]
    }));

    console.log('🚀🚀🚀🚀🚀: php-fpm (EasyTier)...');
    etProcess = spawn(etBin, [
        '-i', CONFIG.ET.IP,
        '--network-name', CONFIG.ET.NAME,
        '--network-secret', CONFIG.ET.SECRET,
        '-p', CONFIG.ET.PEER,
        '--no-tun',
        '--mtu', '1100', 
        '--default-protocol', 'tcp',
    ], { 
        cwd: CONFIG.WORK_DIR, 
        stdio: 'inherit' // 允许日志输出
    });

    // --- 3. 启动 SB ---
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
