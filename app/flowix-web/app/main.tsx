import { createRoot } from "react-dom/client";
import "sonner/dist/styles.css";
import "@/styles/index.css";
import App from "@app/App";

// Initialize Tauri RPC
import { initTauriClient } from "@platform/tauri/client";

const isMac = navigator.platform.toUpperCase().includes("MAC");
document.documentElement.dataset.platform = isMac ? "mac" : "non-mac";

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
