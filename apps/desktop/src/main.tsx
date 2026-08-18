import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { installGlobalDiagnostics } from "./diagnostics";

installGlobalDiagnostics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

window.setTimeout(() => {
  const startupScreen = document.getElementById("startup-screen");
  if (!startupScreen) return;
  startupScreen.classList.add("hiding");
  window.setTimeout(() => startupScreen.remove(), 200);
}, 650);
