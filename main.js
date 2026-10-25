'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths (dev = project dir, packaged = resources dir)
// ---------------------------------------------------------------------------
const RES = () => (app.isPackaged ? process.resourcesPath : __dirname);
const binDir = () => path.join(RES(), 'bin');
const engineDir = () => path.join(RES(), 'engine');
const bridgePath = () => path.join(RES(), 'bridge', 'resolve_bridge.py');

const tmpDir = () => path.join(app.getPath('userData'), 'tmp');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let mainWindow = null;
const procs = new Map(); // pid -> ChildProcess

function ensureTmp() {
  const d = tmpDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch (_) {}
}

function defaultDownloadsDir() {
  const base = app.getPath('videos') || app.getPath('home');
  return path.join(base, 'BaixaAiPRO');
}

function getDownloadsDir() {
  const s = loadSettings();
  const d = s.downloadsDir || defaultDownloadsDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

// ---------------------------------------------------------------------------
// Locate the Python interpreter bundled with DaVinci Resolve
// ---------------------------------------------------------------------------
function findResolvePython() {
  const cands = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const base of [pf, pf86]) {
      cands.push(path.join(base, 'Blackmagic Design', 'DaVinci Resolve', 'ResolvePython', 'ResolvePython.exe'));
    }
    // Registry (InstallPath)
    for (const key of [
      'HKLM\\SOFTWARE\\Blackmagic Design\\DaVinci Resolve',
      'HKLM\\SOFTWARE\\WOW6432Node\\Blackmagic Design\\DaVinci Resolve',
    ]) {
      try {
        const out = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
        if (m && m[1]) cands.push(path.join(m[1].trim(), 'ResolvePython', 'ResolvePython.exe'));
      } catch (_) {}
    }
  } else if (process.platform === 'darwin') {
    const appBase = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents';
    for (const v of ['3.14', '3.13', '3.12', '3.11', '3.10', '3.9', '3.8', '3.7', '3.6']) {
      cands.push(path.join(appBase, 'Frameworks', 'Python.framework', 'Versions', v, 'bin', 'python' + v));
      cands.push(path.join(appBase, 'Frameworks', 'Python.framework', 'Versions', v, 'bin', 'python3'));
    }
    cands.push('/usr/bin/python3');
  } else {
    cands.push('/opt/resolve/bin/python3');
    cands.push('/usr/bin/python3');
  }
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolve bridge call (request -> temp files -> spawn bundled Python)
// ---------------------------------------------------------------------------
async function resolveCall(action, params) {
  const python = findResolvePython();
  if (!python) {
    return {
      status: 'NO_PYTHON',
      message:
        'DaVinci Resolve nao foi encontrado neste computador. Instale o DaVinci Resolve (gratuito) em blackmagicdesign.com.',
    };
  }
  ensureTmp();
  const id = crypto.randomBytes(6).toString('hex');
  const reqFile = path.join(tmpDir(), `resolve_req_${id}.json`);
  const outFile = path.join(tmpDir(), `resolve_out_${id}.json`);
  fs.writeFileSync(reqFile, JSON.stringify({ action, ...(params || {}) }), 'utf8');

  const bridge = bridgePath();
  const exitCode = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [bridge, reqFile, outFile], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      return resolve(-1);
    }
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code == null ? -1 : code));
  });

  let result;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (_) {
    result = {
      status: 'ERROR',
      message: 'A ponte do Resolve nao retornou resultado (exit ' + exitCode + ').',
    };
  }
  try { fs.unlinkSync(reqFile); } catch (_) {}
  try { fs.unlinkSync(outFile); } catch (_) {}
  return result;
}

// ---------------------------------------------------------------------------
// Captura do audio do computador (loopback) para o reconhecedor
// ---------------------------------------------------------------------------
function ffmpegBin() {
  return path.join(binDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function listAudioDevices() {
  return new Promise((resolve) => {
    const ff = ffmpegBin();
    if (!fs.existsSync(ff)) return resolve({ ok: false, devices: [] });
    let args;
    if (process.platform === 'win32') {
      args = ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
    } else if (process.platform === 'darwin') {
      args = ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
    } else {
      return resolve({ ok: false, devices: [] });
    }
    let err = '';
    let child;
    try {
      child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (_) {
      return resolve({ ok: false, devices: [] });
    }
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve({ ok: false, devices: [] }));
    child.on('exit', () => {
      const devices = [];
      if (process.platform === 'win32') {
        // linhas: [dshow @ ...] "Nome do dispositivo"
        const re = /\]\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(err))) devices.push({ name: m[1] });
      } else {
        // bloco "AVFoundation audio devices:" seguido de "[idx] Nome"
        const lines = err.split(/\r?\n/);
        let inAudio = false;
        for (const line of lines) {
          if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
          if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
          if (inAudio) {
            const m = line.match(/\]\s*\[(\d+)\]\s*(.+)$/);
            if (m) devices.push({ name: m[2].trim(), index: m[1] });
          }
        }
      }
      resolve({ ok: true, devices });
    });
  });
}

function pickLoopbackDevice(devices) {
  const pat = process.platform === 'win32'
    ? /stereo mix|what u hear|loopback|cable output|vb-?audio|virtual audio/i
    : /blackhole|loopback|soundflower|aggregate|virtual/i;
  for (const d of devices) {
    if (pat.test(d.name)) return d;
  }
  return null;
}

async function captureSystemAudio(seconds) {
  const ff = ffmpegBin();
  if (!fs.existsSync(ff)) {
    return { status: 'ERROR', message: 'ffmpeg nao encontrado no programa.' };
  }
  const secs = Math.max(6, Math.min(20, Number(seconds) || 12));
  const info = await listAudioDevices();
  if (!info.ok) {
    return { status: 'ERROR', message: 'Nao foi possivel listar os dispositivos de audio.' };
  }
  const dev = pickLoopbackDevice(info.devices);
  if (!dev) {
    const hint = process.platform === 'win32'
      ? 'Ative o "Stereo Mix" (Configuracoes de Som > Gravacao > Mostrar dispositivos desabilitados) ou instale o VB-Cable (vb-audio.com/Cable).'
      : 'Instale o BlackHole (blackholeaudio.com) e selecione-o como saida de audio do Mac.';
    return {
      status: 'NO_DEVICE',
      message: 'Nao encontrei um dispositivo de captura do audio do computador. ' + hint,
      devices: info.devices.map((d) => d.name),
    };
  }

  ensureTmp();
  const outFile = path.join(tmpDir(), 'capture_' + Date.now() + '.wav');
  const args = process.platform === 'win32'
    ? ['-y', '-f', 'dshow', '-i', 'audio=' + dev.name, '-t', String(secs), '-ac', '1', '-ar', '16000', outFile]
    : ['-y', '-f', 'avfoundation', '-i', ':' + dev.index, '-t', String(secs), '-ac', '1', '-ar', '16000', outFile];

  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(ff, args, { stdio: 'ignore', windowsHide: true });
    } catch (_) {
      return resolve(-1);
    }
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c == null ? -1 : c));
  });

  try {
    const st = fs.statSync(outFile);
    if (st.size < 1000) {
      return { status: 'ERROR', message: 'A captura saiu vazia. Verifique se ha audio tocando.' };
    }
    return { status: 'OK', filePath: outFile, device: dev.name || ('dispositivo ' + dev.index), seconds: secs, size: st.size };
  } catch (_) {
    return { status: 'ERROR', message: 'Nao foi possivel capturar o audio (exit ' + code + ').' };
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('resolve-call', (_e, payload) => resolveCall(payload.action, payload.params));
  ipcMain.handle('capture-audio', (_e, seconds) => captureSystemAudio(seconds));

  ipcMain.handle('open-folder', (_e, folder) => {
    try {
      shell.openPath(folder);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  });

  ipcMain.handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Escolha a pasta de download',
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('get-paths', () => ({
    binDir: binDir(),
    engineDir: engineDir(),
    bridgePath: bridgePath(),
    tmpDir: ensureTmp(),
    downloadsDir: getDownloadsDir(),
    platform: process.platform,
  }));

  ipcMain.handle('get-downloads-dir', () => getDownloadsDir());
  ipcMain.handle('set-downloads-dir', (_e, dir) => {
    const s = loadSettings();
    s.downloadsDir = dir;
    saveSettings(s);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  });

  // Filesystem primitives (espelha o cep.fs do Premiere)
  ipcMain.handle('fs-write', (_e, { p, c }) => {
    try { fs.writeFileSync(p, c, 'utf8'); return { err: 0 }; } catch (err) { return { err: 1, data: String(err) }; }
  });
  ipcMain.handle('fs-read', (_e, p) => {
    try { return { err: 0, data: fs.readFileSync(p, 'utf8') }; } catch (err) { return { err: 1, data: '' }; }
  });
  ipcMain.handle('fs-delete', (_e, p) => {
    try { fs.unlinkSync(p); return { err: 0 }; } catch (err) { return { err: 1 }; }
  });
  ipcMain.handle('fs-exists', (_e, p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });

  // Process primitives (espelha o cep.process do Premiere)
  ipcMain.handle('proc-create', (_e, { cmd, args }) => {
    try {
      const child = spawn(cmd, args || [], { stdio: 'ignore', windowsHide: true, detached: false });
      const pid = child.pid;
      procs.set(pid, child);
      child.on('exit', () => { /* mantem no map; isRunning usa exitCode */ });
      child.on('error', () => {});
      return { err: 0, data: pid };
    } catch (err) {
      return { err: 1, data: String(err) };
    }
  });
  ipcMain.handle('proc-isrunning', (_e, pid) => {
    const child = procs.get(pid);
    if (!child) return { err: 0, data: false };
    const alive = child.exitCode === null && child.signalCode === null;
    return { err: 0, data: alive };
  });
}

// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 780,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#131316',
    title: 'BaixaAiPRO',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Smoke test (dev): BAIXAAI_SMOKE=1 executa um autoteste e encerra.
  if (process.env.BAIXAAI_SMOKE === '1') {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(
          `(async () => {
            const paths = await window.api.getPaths();
            const proj = await window.api.resolveCall('get_project', {});
            const cand = await window.api.resolveCall('get_candidates', {});
            return JSON.stringify({ paths, proj, cand });
          })()`
        );
        console.log('SMOKE_RESULT ' + result);
      } catch (err) {
        console.log('SMOKE_ERROR ' + String(err));
      }
      app.quit();
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
