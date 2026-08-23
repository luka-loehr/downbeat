import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// See `html.revealed` in index.css: guarantees content is visible even if the
// entrance animations never get a chance to run.
setTimeout(() => document.documentElement.classList.add("revealed"), 1200);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
