import { createRoot } from "react-dom/client";
import "./css/index.css";
import App from "./App";

// Initialize Tauri RPC
import { initTauriClient } from "./lib/tauri/client";

try {
  initTauriClient();
} catch (err) {
  console.error("[main.tsx] Failed to initialize Tauri:", err);
}

createRoot(document.getElementById("root")!).render(
  <>
    {/* <StrictMode> */}
    <App />
    {/* </StrictMode> */}
  </>,
);
