import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/global.css";
import { App } from "./app/App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("RbxForge renderer root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
