// Electron desktop shell. Boots the Next.js server as a child process, waits for it to
// answer, then opens a window pointed at it.
//   dev  (ELECTRON_DEV=1): spawns `next dev`
//   prod (default):        runs the standalone build (.next/standalone/server.js)
// The Next server runs the local scheduler (src/instrumentation.ts), so automation is
// active only while this app is open — by design for a single-operator desktop build.
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = process.env.PORT || "3123";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const isDev = process.env.ELECTRON_DEV === "1";
const root = path.join(__dirname, "..");

let server; // Next.js child process

function startServer() {
  const env = { ...process.env, PORT, HOSTNAME: "127.0.0.1" };
  if (isDev) {
    server = spawn("npx", ["next", "dev", "-p", PORT], { cwd: root, env, stdio: "inherit", shell: true });
    server.on("exit", (code) => code && console.error(`[next] server exited with code ${code}`));
    return;
  }
  // Packaged: standalone dir is shipped via extraResources → resources/standalone.
  // From source (desktop:prod): it lives at .next/standalone. Either way it is self-contained.
  const serverJs = app.isPackaged
    ? path.join(process.resourcesPath, "standalone", "server.js")
    : path.join(root, ".next", "standalone", "server.js");
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node for the server.
  server = spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs), env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit",
  });
  server.on("exit", (code) => code && console.error(`[next] server exited with code ${code}`));
}

function waitForServer(onReady, tries = 0) {
  http.get(ORIGIN, () => onReady()).on("error", () => {
    if (tries > 120) { console.error("[next] server did not start in 60s"); app.quit(); return; }
    setTimeout(() => waitForServer(onReady, tries + 1), 500);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880, title: "Meta Ads Manager",
    webPreferences: { contextIsolation: true },
  });
  // External links (Meta Ad Library, docs) open in the system browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.loadURL(ORIGIN);
}

app.whenReady().then(() => {
  startServer();
  waitForServer(createWindow);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
app.on("quit", () => server && server.kill());
