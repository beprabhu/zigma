// Zigma desktop shell — a thin window around the team server, the way Figma's desktop app
// wraps figma.com. The app itself carries no product code: pushing to the Mac mini updates
// what everyone sees, and this wrapper only changes when the shell itself needs a feature.
//
// Server URL resolution, first match wins:
//   1. ZIGMA_URL environment variable (power users, testing)
//   2. ~/Library/Application Support/Zigma/server-url.txt (set via the app menu)
//   3. http://localhost:3000 (developing on the same machine)

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'http://localhost:3000';
const urlFile = () => path.join(app.getPath('userData'), 'server-url.txt');

function readServerUrl() {
  if (process.env.ZIGMA_URL) return process.env.ZIGMA_URL;
  try {
    const saved = fs.readFileSync(urlFile(), 'utf8').trim();
    if (saved) return saved;
  } catch {}
  return DEFAULT_URL;
}

function writeServerUrl(value) {
  fs.mkdirSync(path.dirname(urlFile()), { recursive: true });
  fs.writeFileSync(urlFile(), value.trim());
}

// The BG remover's multithreaded WASM needs crossOriginIsolated, which browsers only grant on
// secure contexts. The mini serves plain http on the LAN — inside this shell we vouch for that
// origin ourselves, which is exactly the knob a generic browser refuses to expose per-site.
// Must be set before app.whenReady.
const serverUrl = readServerUrl();
try {
  const origin = new URL(serverUrl).origin;
  if (origin.startsWith('http://') && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', origin);
  }
} catch {}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: 'Zigma',
    backgroundColor: '#1e1e1e',
    // No title bar and no title — just the traffic lights floating over the page, which runs
    // edge to edge behind them. The rail in the web app pads its top to clear them and makes
    // that strip the drag handle (components/app-sidebar.tsx).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      // The renderer is the remote web app; it gets no Node access.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // How the web app tells it's inside this shell (and so must clear the traffic lights) rather
  // than in a browser tab. A distinct token, not a check for 'Electron': other Electron-based
  // browsers carry that in their UA too and would wrongly get the desktop chrome. Set on the
  // webContents so it survives reloads and in-app navigation.
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ZigmaShell/${app.getVersion()}`);

  // Target=_blank and friends open in the real browser, not in more shell windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    if (code === -3) return; // aborted (normal during reload)
    dialog
      .showMessageBox(win, {
        type: 'warning',
        message: 'Could not reach the Zigma server',
        detail: `${failedUrl}\n${desc} (${code})\n\nCheck that the server is running, or set a different URL from  Zigma ▸ Set Server URL…`,
        buttons: ['Retry', 'Close'],
      })
      .then(({ response }) => {
        if (response === 0) win.loadURL(readServerUrl());
      });
  });

  win.loadURL(serverUrl);
}

function openSettings() {
  const settings = new BrowserWindow({
    width: 480,
    height: 200,
    parent: win ?? undefined,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Server URL',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  settings.removeMenu?.();
  settings.loadFile('settings.html', { query: { current: readServerUrl() } });
}

ipcMain.handle('zigma:set-server-url', (_event, value) => {
  try {
    const parsed = new URL(String(value));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('http(s) only');
    writeServerUrl(parsed.origin);
    // The secure-origin switch is applied at launch, so a URL change needs a relaunch to
    // carry it; relaunching also guarantees a clean load of the new origin.
    app.relaunch();
    app.exit(0);
  } catch (e) {
    return `Not a valid URL: ${String(value)}`;
  }
  return null;
});

// One window per user — a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // A packaged .app takes its Dock icon from the bundle (build/icon.icns, wired up in
    // package.json). Running unpackaged there is no bundle, so the Dock falls back to the
    // generic Electron icon unless we set it here from the same artwork.
    if (!app.isPackaged && process.platform === 'darwin') {
      try {
        app.dock?.setIcon(path.join(__dirname, 'build', 'icon-1024.png'));
      } catch {}
    }

    // Standard roles keep every system shortcut working inside the web app — copy/paste in
    // fields, ⌘R reload, zoom, fullscreen. The page's own shortcuts (⌘\ panels, D theme)
    // pass through untouched.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Zigma',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Set Server URL…', accelerator: 'Cmd+,', click: openSettings },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
            { role: 'toggleDevTools' },
          ],
        },
        { role: 'windowMenu' },
      ]),
    );
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
