import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError } from "@tauri-apps/plugin-log";
import App from "./App";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-ext-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./index.css";

// Erreurs de l'interface inscrites dans le journal local, pour pouvoir les diagnostiquer.
window.addEventListener("error", (e) => void logError(`interface : ${e.message} (${e.filename}:${e.lineno})`).catch(() => {}));
window.addEventListener("unhandledrejection", (e) => void logError(`interface : ${String(e.reason)}`).catch(() => {}));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
