const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Expected a callback");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  "localWhispr",
  Object.freeze({
    getState: () => ipcRenderer.invoke("local:get-state"),
    updateSettings: (patch) => ipcRenderer.invoke("local:update-settings", patch),
    requestPermission: (kind) => ipcRenderer.invoke("local:request-permission", kind),
    prepareLocal: () => ipcRenderer.invoke("local:prepare-local"),
    checkConnections: () => ipcRenderer.invoke("local:check-connections"),
    beginRecording: () => ipcRenderer.invoke("local:begin-recording"),
    transcribe: (request) => ipcRenderer.invoke("local:transcribe", request),
    cancel: (requestId) => ipcRenderer.invoke("local:cancel", requestId),
    copyTranscript: (id, source) => ipcRenderer.invoke("local:copy-transcript", id, source),
    rewriteTranscript: (id) => ipcRenderer.invoke("local:rewrite-transcript", id),
    undoTranscript: (id) => ipcRenderer.invoke("local:undo-transcript", id),
    acceptSuggestion: (id) => ipcRenderer.invoke("local:accept-suggestion", id),
    deleteTranscript: (id) => ipcRenderer.invoke("local:delete-transcript", id),
    hideWindow: () => ipcRenderer.invoke("local:hide-window"),
    onState: (callback) => subscribe("local:state", callback),
    onCommand: (callback) => subscribe("local:command", callback),
  })
);
