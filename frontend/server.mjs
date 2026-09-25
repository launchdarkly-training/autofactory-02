/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend-status line on the page is gated by the multivariate flag
 * "enable-backend-status": "control" renders the page exactly as before, "v1"
 * adds the status line.
 */

import express from "express";
import { pathToFileURL } from "node:url";

import { getLdClient, ldContext, stringVariation } from "./flags.mjs";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const BACKEND_STATUS_FLAG = "enable-backend-status";

function renderPage({ showBackendStatus }) {
  const statusElement = showBackendStatus
    ? `\n  <p id="backend-status">Checking backend status…</p>`
    : "";
  const statusScript = showBackendStatus
    ? `
    function reportBackendStatus(outcome, elapsedMs) {
      try {
        navigator.sendBeacon("/api/backend-status-event?outcome=" + outcome + "&ms=" + Math.round(elapsedMs));
      } catch (e) { /* telemetry must never break the page */ }
    }
    var backendStatusStartedAt = Date.now();
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version;
        reportBackendStatus("ok", Date.now() - backendStatusStartedAt); })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline";
        reportBackendStatus("error", Date.now() - backendStatusStartedAt); });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${statusElement}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${statusScript}
  </script>
</body></html>`;
}

export function createApp({ ldClient = getLdClient() } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const variation = await stringVariation(ldClient, BACKEND_STATUS_FLAG, "control");
    res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));
  });

  // Guarded-release telemetry for enable-backend-status. The status check runs
  // in the browser, where the Node server SDK cannot see it, so the v1 page
  // beacons its outcome here and the server emits the custom events. Only the
  // v1 page calls this route; the control page never does.
  app.post("/api/backend-status-event", (req, res) => {
    res.status(204).end();
    try {
      if (!ldClient) {
        return;
      }
      const context = ldContext();
      const elapsedMs = Number(req.query.ms);
      if (req.query.outcome === "ok") {
        ldClient.track("enable-backend-status-success", context);
      } else if (req.query.outcome === "error") {
        ldClient.track("enable-backend-status-error", context);
      }
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
        ldClient.track("enable-backend-status-latency", context, undefined, elapsedMs);
      }
    } catch {
      // Telemetry failures must never surface to the caller.
    }
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`demo-frontend on :${port}`));
}
