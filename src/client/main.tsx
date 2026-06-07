import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@troop10rwc/ui/fonts.css"; // fonts first
import "@troop10rwc/ui/theme.css"; // then --t10-* tokens
import "./styles.css"; // app overrides last

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
