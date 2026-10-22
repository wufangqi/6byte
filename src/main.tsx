import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installTheme } from "./features/theme";
import "./styles.css";

installTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
