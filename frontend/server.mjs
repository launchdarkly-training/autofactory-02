/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend status line is gated by the multivariate flag
 * "enable-backend-status": "v1" renders it, "control" (the fail-safe default)
 * renders the page exactly as it was before the flag existed.
 *
 * The status check runs in the browser, where the Node server SDK cannot see
 * it, so the v1 page beacons its outcome to POST /api/backend-status-outcome
 * and the server emits the guarded-release events from there.
 */

import { pathToFileURL } from "node:url";

import express from "express";
import { init as initLd } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";
const SDK_KEY = process.env.LD_SDK_KEY;

export const FLAG_BACKEND_STATUS = "enable-backend-status";

/** Matches the backend's context convention (backend/app.py `_ld_context`). */
function ldContext() {
  return { kind: "user", key: "demo-user" };
}

/**
 * Initialize the LaunchDarkly client, or return null when LD is unavailable.
 * Mirrors the backend's graceful degradation: no key, no client, no throw.
 */
export async function initLdClient() {
  if (!SDK_KEY) return null;
  try {
    const client = initLd(SDK_KEY);
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    return null;
  }
}

/**
 * Read a string variation with a fail-safe `control` default. A missing client,
 * an evaluation error, or a non-string value all degrade to `control` so the
 * page keeps its pre-flag behavior.
 */
async function stringVariation(ldClient, key, defaultValue = "control") {
  if (!ldClient) return defaultValue;
  try {
    const value = await ldClient.variation(key, ldContext(), defaultValue);
    return typeof value === "string" ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Emit a custom event, never letting a telemetry failure break the request. */
function track(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, ldContext(), undefined, metricValue);
  } catch {
    // telemetry is best-effort
  }
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  // Guarded-release telemetry for the v1 status line. sendBeacon posts a Blob,
  // so text/plain is accepted alongside application/json.
  app.post(
    "/api/backend-status-outcome",
    express.json({ type: ["application/json", "text/plain"], limit: "1kb" }),
    (req, res) => {
      const body = req.body ?? {};
      // Only a real number counts: Number(null) is 0, which would land in the
      // latency metric as a free 0ms sample.
      const elapsedMs = typeof body.elapsedMs === "number" ? body.elapsedMs : NaN;

      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 60000) {
        track(ldClient, "enable-backend-status-latency", elapsedMs);
      }
      if (body.ok === true) {
        track(ldClient, "enable-backend-status-success");
      } else {
        track(ldClient, "enable-backend-status-error");
      }

      res.status(204).end();
    },
  );

  app.get("/", async (_req, res) => {
    const showStatus =
      (await stringVariation(ldClient, FLAG_BACKEND_STATUS, "control")) === "v1";

    const statusElement = showStatus
      ? `\n  <p id="backend-status">Checking backend status…</p>`
      : "";
    const statusScript = showStatus
      ? `
    (() => {
      const started = performance.now();
      const report = (ok) => {
        const body = JSON.stringify({ ok: ok, elapsedMs: Math.round(performance.now() - started) });
        navigator.sendBeacon("/api/backend-status-outcome", new Blob([body], { type: "application/json" }));
      };
      fetch("${BACKEND_URL}/api/status")
        .then(r => r.json())
        .then(d => { document.getElementById("backend-status").textContent =
          "Backend online: " + d.service + " version " + d.version; report(true); })
        .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; report(false); });
    })();`
      : "";

    res.type("html").send(`<!doctype html>
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
</body></html>`);
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () =>
    console.log(`demo-frontend on :${port}`),
  );
}
