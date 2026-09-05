import React from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./styles.css";
import App from "./App";

async function mount() {
  const preview =
    import.meta.env.DEV &&
    !window.localWhispr &&
    new URLSearchParams(location.search).get("preview") === "1";
  if (preview && !window.localWhispr) {
    const { createPreviewAPI } = await import("./preview");
    window.localWhispr = createPreviewAPI();
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App preview={preview} />
    </React.StrictMode>
  );
}
void mount();
