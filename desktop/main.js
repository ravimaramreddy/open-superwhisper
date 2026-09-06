const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  ipcMain,
  systemPreferences,
  clipboard,
  dialog,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Controller } = require("./controller");
const { History } = require("./history");
const { createNative } = require("./native");
const { createInference } = require("./inference");
const { loadMachineConfig } = require("./machine-config");

app.setName("OpenSuperwhisper");
app.setPath("userData", path.join(app.getPath("appData"), "OpenSuperwhisper"));

let window;
let tray;
let controller;
let inference;
let quitting = false;
let shuttingDown = false;
let activeShortcut = null;
let escapeRegistered = false;
let rendererReady = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function showWindow() {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function command(value) {
  if (!rendererReady || !window || window.isDestroyed()) return;
  if (
    value === "toggle" &&
    ["processing", "delivering", "setup"].includes(controller.getState().phase)
  )
    return;
  // Keep the renderer alive while hidden and leave the editing app focused.
  window.webContents.send("local:command", value);
}

function registerShortcut(next) {
  if (next === activeShortcut) return;
  if (!globalShortcut.register(next, () => command("toggle")))
    throw new Error("That shortcut is already in use. Choose another shortcut.");
  if (activeShortcut) globalShortcut.unregister(activeShortcut);
  activeShortcut = next;
}

function publish(state) {
  const needsEscape = ["recording", "processing", "delivering"].includes(state.phase);
  if (needsEscape && !escapeRegistered) {
    escapeRegistered = globalShortcut.register("Escape", () => {
      void controller.cancel();
      command("cancel");
    });
  } else if (!needsEscape && escapeRegistered) {
    globalShortcut.unregister("Escape");
    escapeRegistered = false;
  }
  if (window && !window.isDestroyed() && rendererReady)
    window.webContents.send("local:state", state);
  if (tray) {
    tray.setToolTip(
      state.phase === "idle" ? "OpenSuperwhisper" : `OpenSuperwhisper — ${state.progress}`
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open OpenSuperwhisper", click: showWindow },
        {
          label: state.phase === "recording" ? "Finish dictation" : "Start dictation",
          enabled: ["idle", "recording"].includes(state.phase),
          click: () => command("toggle"),
        },
        {
          label: "Cancel",
          enabled: needsEscape,
          click: () => {
            void controller.cancel();
            command("cancel");
          },
        },
        { type: "separator" },
        { label: "Quit OpenSuperwhisper", click: () => app.quit() },
      ])
    );
  }
}

function rendererLocation() {
  const development = process.env.LOCAL_WHISPR_DEV_URL || process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && development) {
    const url = new URL(development);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Development renderer must use loopback HTTP");
    return url.href;
  }
  return pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
}

function trustedURL(actual, expected) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    if (e.protocol === "file:") return a.protocol === "file:" && a.pathname === e.pathname;
    return a.origin === e.origin && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

async function start() {
  if (process.platform !== "darwin") throw new Error("This build supports macOS only");
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const history = new History(path.join(userData, "history.json"));
  const native = createNative({
    binary: app.isPackaged
      ? path.join(process.resourcesPath, "..", "Frameworks", "macos-local-paste.node")
      : path.join(app.getAppPath(), "resources", "bin", "macos-local-paste.node"),
    clipboard,
  });
  const machine = loadMachineConfig(userData);
  inference = createInference({
    userData,
    resourcesPath: process.resourcesPath,
    config: machine.config,
    onProgress: (message) => controller?.progress(message),
  });
  controller = new Controller({
    userData,
    history,
    inference,
    native,
    clipboard,
    onState: publish,
    permissions: {
      get: () => ({
        microphone: systemPreferences.getMediaAccessStatus("microphone"),
        accessibility: native.accessibility(),
      }),
      request: async (kind) => {
        if (kind === "microphone") await systemPreferences.askForMediaAccess("microphone");
        else {
          systemPreferences.isTrustedAccessibilityClient(true);
          await shell.openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
          );
        }
      },
    },
    applySettings: async (next, previous) => {
      registerShortcut(next.hotkey);
      if (next.launchAtLogin !== previous.launchAtLogin)
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    },
  });
  try {
    registerShortcut(controller.state.settings.hotkey);
  } catch (error) {
    controller.state.error = error.message;
  }
  if (machine.warning)
    controller.state.error = [controller.state.error, machine.warning].filter(Boolean).join(" ");

  const location = rendererLocation();
  window = new BrowserWindow({
    title: "OpenSuperwhisper",
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f0e8",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!trustedURL(url, location)) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents === window.webContents &&
          permission === "media" &&
          trustedURL(contents.getURL(), location) &&
          Array.isArray(details.mediaTypes) &&
          details.mediaTypes.length > 0 &&
          details.mediaTypes.every((type) => type === "audio")
      );
    }
  );
  window.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === window.webContents &&
      trustedURL(contents.getURL(), location) &&
      permission === "media" &&
      details.mediaType === "audio"
  );
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("focus", () => publish(controller.getState()));
  window.webContents.on("render-process-gone", () => {
    rendererReady = false;
    void controller.cancel();
  });
  window.webContents.on("did-start-loading", () => {
    if (rendererReady) {
      rendererReady = false;
      void controller.cancel();
    }
  });
  window.webContents.on("did-finish-load", () => {
    rendererReady = true;
    publish(controller.getState());
  });

  const handlers = {
    "get-state": () => controller.getState(),
    "update-settings": (patch) => controller.updateSettings(patch),
    "request-permission": (kind) => controller.requestPermission(kind),
    "prepare-local": () => controller.prepareLocal(),
    "check-connections": () => controller.checkConnections(),
    "begin-recording": () => controller.beginRecording(),
    transcribe: (request) => controller.transcribe(request),
    cancel: (requestId) => controller.cancel(requestId),
    "copy-transcript": (id, source) => controller.copyTranscript(id, source),
    "rewrite-transcript": (id) => controller.rewriteTranscript(id),
    "undo-transcript": (id) => controller.undoTranscript(id),
    "accept-suggestion": (id) => controller.acceptSuggestion(id),
    "delete-transcript": (id) => controller.deleteTranscript(id),
    "open-audio-folder": async () => {
      const error = await shell.openPath(controller.audioDirectory());
      if (error) throw new Error("The recordings folder could not be opened");
    },
    "show-recording": (id) => shell.showItemInFolder(controller.recordingFile(id)),
    "hide-window": () => {
      window.hide();
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`local:${name}`, (event, ...args) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !trustedURL(event.senderFrame.url, location)
      )
        throw new Error("Untrusted app window");
      return handler(...args);
    });
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "OpenSuperwhisper",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { label: "Show OpenSuperwhisper", click: showWindow }],
      },
    ])
  );
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "trayTemplate.png")
    : path.join(app.getAppPath(), "src", "assets", "iconTemplate@3x.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", showWindow);
  publish(controller.getState());
  await window.loadURL(location);
  window.show();
  // A readiness check does not load a model or start inference.
  await controller.checkConnections();
}

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  command("cancel");
  rendererReady = false;
  globalShortcut.unregisterAll();
  void (async () => {
    try {
      await controller?.cancel();
      await inference?.shutdown();
      await controller?.drain();
    } finally {
      quitting = true;
      // Cleanup is complete. Do not re-enter the cancellable quit event;
      // a second quit can leave a windowless macOS process behind.
      app.exit(0);
    }
  })();
});
if (gotLock)
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("OpenSuperwhisper could not start", error.message);
      app.quit();
    });
