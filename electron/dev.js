// 开发模式辅助：等 Vite server 和 TS 主进程产物都就绪后再启动 Electron
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const VITE_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main', 'main', 'main.js');

function waitForVite(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(VITE_URL, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Vite server timeout'));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

function waitForFile(file, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting ' + file));
      setTimeout(tick, 500);
    };
    tick();
  });
}

(async () => {
  console.log('[dev] 等待 Vite dev server:', VITE_URL);
  await waitForVite();
  console.log('[dev] Vite 就绪');
  console.log('[dev] 等待主进程编译产物:', MAIN_JS);
  await waitForFile(MAIN_JS);
  console.log('[dev] 启动 Electron...');
  const electronPath = require('electron');
  const child = spawn(electronPath, [MAIN_JS], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: VITE_URL,
    },
  });
  child.on('close', () => process.exit(0));
})().catch((e) => {
  console.error('[dev] 启动失败:', e.message);
  process.exit(1);
});
