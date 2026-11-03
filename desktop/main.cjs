// Desktop shell.
//
// The panel is a loopback HTTP app with a Node backend, so the shell does the
// least surprising thing: run the real server as a child Node process and point
// a window at it. No IPC bridge, no duplicated logic, and closing the window
// kills the server — same contract as `node bin/ui.mjs`.

const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

app.setName("mcpoll");
app.setAppUserModelId("dev.luvzexi.mcpoll");

// Runtime data (registry, calibration, caches, backups) stays per-user: the
// installed bundle is read-only.
// keep our own files in data/ so they are not mixed with Electron's caches
const DATA = path.join(app.getPath("appData"), "mcpoll", "data");
fs.mkdirSync(DATA, { recursive: true });
app.setPath("userData", DATA);
process.env.MCPOLL_HOME = DATA;

const APP_DIR = path.join(__dirname, "..");
const LOG = path.join(DATA, "desktop.log");

let server = null;
let win = null;

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function startServer() {
  return new Promise((resolve, reject) => {
    const script = path.join(APP_DIR, "bin", "ui.mjs");
    server = spawn(process.execPath, [script, "--port", "0", "--no-open"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => reject(new Error("server did not report a port in 20s")), 20_000);
    let buf = "";

    server.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/mcpoll\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    server.stderr.on("data", (d) => log(`server: ${d.toString().trim()}`));
    server.on("exit", (code) => {
      log(`server exited ${code}`);
      if (win && !win.isDestroyed()) win.webContents.loadURL("data:text/html,<body style='background:%230b0b0c;color:%23b3b3ba;font:14px system-ui;padding:40px'>后台进程已退出，请重启 mcpoll。</body>");
    });
    server.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function openWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    // match the page before first paint so there is no white flash
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#fbfbfd",
    title: "mcpoll",
    icon: path.join(APP_DIR, "build", "icon.ico"),
    autoHideMenuBar: true,
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // stay on the loopback app; anything else belongs in the real browser
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });

  // no menu bar, but keep the two shortcuts that matter for a local tool
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const k = input.key.toLowerCase();
    if (k === "f12" || (input.control && input.shift && k === "i")) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
    if (input.control && k === "r") {
      win.webContents.reload();
      e.preventDefault();
    }
  });

  win.on("closed", () => {
    win = null;
    app.quit();
  });

  win.loadURL(url);
}

function shutdown() {
  if (server && !server.killed) {
    try {
      server.kill();
    } catch {}
  }
  server = null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    log(`start ${app.getVersion()} data=${DATA}`);
    try {
      const url = await startServer();
      log(`server ready ${url}`);
      openWindow(url);
    } catch (e) {
      log(`fatal ${e.message}`);
      dialog.showErrorBox("mcpoll 启动失败", String(e.message));
      app.quit();
    }
  });

  app.on("before-quit", shutdown);
  app.on("window-all-closed", () => app.quit());
  process.on("exit", shutdown);
}
