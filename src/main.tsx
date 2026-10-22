import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installLocale } from "./i18n";
import { installTheme } from "./features/theme";
import "./styles.css";

installTheme();
installLocale();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
