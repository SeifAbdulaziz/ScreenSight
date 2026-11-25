import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const identifyParam = new URLSearchParams(window.location.search).get("identify");

if (identifyParam !== null) {
  // Click-through Identify overlay windows must remain transparent around the badge.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <div className="h-screen w-screen flex items-center justify-center bg-transparent select-none pointer-events-none">
      <div className="h-24 w-24 rounded-2xl bg-zinc-950/90 border-2 border-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.55)] flex flex-col items-center justify-center">
        <span className="text-[10px] uppercase tracking-widest text-emerald-400/90 font-semibold">
          Display
        </span>
        <span className="text-4xl font-black font-mono text-white leading-none mt-0.5">
          {identifyParam}
        </span>
      </div>
    </div>
  );
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
