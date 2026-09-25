/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The greeting page variant is gated by the LaunchDarkly flag
 * `shift2-enable-greeting-refresh` (string multivariate, default "control").
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const GREETING_REFRESH_FLAG = "shift2-enable-greeting-refresh";
export const GREETING_EVENT_PATH = "/api/greeting-refresh-event";

/**
 * Lazily initialize the LaunchDarkly client (or return null if unavailable).
 * Mirrors the backend's convention: without LD_SDK_KEY the app still runs and
 * every flag falls back to its control value.
 */
function createLdClient() {
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) return null;
  try {
    const client = init(sdkKey);
    client.waitForInitialization({ timeout: 5 }).catch(() => {});
    return client;
  } catch {
    return null;
  }
}

function ldContext() {
  return { kind: "user", key: "demo-user" };
}

/**
 * Emit a custom event for the guarded release. Telemetry must never fail a
 * request, so every failure (including a missing client) is swallowed.
 */
function track(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, ldContext(), undefined, metricValue);
  } catch {
    /* telemetry is best-effort */
  }
}

/**
 * Evaluate the greeting-refresh flag as a STRING variation. Anything other
 * than an exact match on a known variation value degrades to "control", so an
 * unreachable LaunchDarkly, a missing flag, or an unexpected value all serve
 * the existing page.
 */
async function greetingRefreshVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(GREETING_REFRESH_FLAG, ldContext(), "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

function controlPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;
}

/**
 * The v1 page reports the outcome of each greeting load back to this service
 * (the browser cannot talk to the server-side SDK), which turns it into the
 * guarded-release custom events. The control page never beacons, so its
 * markup and its network behavior stay exactly as they were.
 */
function refreshPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <button id="refresh" type="button">Refresh greeting</button>
  <script>
    function report(outcome) {
      try { navigator.sendBeacon("${GREETING_EVENT_PATH}", JSON.stringify({ outcome: outcome })); } catch (e) {}
    }
    function loadGreeting() {
      document.getElementById("greeting").textContent = "Loading greeting from backend…";
      fetch("${BACKEND_URL}/api/greeting")
        .then(r => r.json())
        .then(d => { document.getElementById("greeting").textContent =
          d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; report("success"); })
        .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; report("error"); });
    }
    loadGreeting();
    document.getElementById("refresh").addEventListener("click", loadGreeting);
  </script>
</body></html>`;
}

export function createApp({ ldClient } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res, next) => {
    const startedAt = Date.now();
    try {
      const variation = await greetingRefreshVariation(ldClient);
      res.type("html").send(variation === "v1" ? refreshPage() : controlPage());
      track(ldClient, "shift2-enable-greeting-refresh-latency", Date.now() - startedAt);
    } catch (err) {
      track(ldClient, "shift2-enable-greeting-refresh-error");
      next(err);
    }
  });

  // Outcome beacon from the v1 page. Unauthenticated by necessity (the page is
  // anonymous); it only ever emits the two known event keys.
  // `navigator.sendBeacon` posts text/plain, so parse the body by hand rather
  // than content type, and never let a malformed payload raise.
  app.post(GREETING_EVENT_PATH, express.text({ type: "*/*", limit: "1kb" }), (req, res) => {
    let outcome;
    try {
      outcome = JSON.parse(req.body || "{}").outcome;
    } catch {
      outcome = undefined;
    }
    if (outcome === "success") {
      track(ldClient, "shift2-enable-greeting-refresh-success");
    } else if (outcome === "error") {
      track(ldClient, "shift2-enable-greeting-refresh-error");
    }
    res.status(204).end();
  });

  return app;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const port = process.env.PORT || 3000;
  createApp({ ldClient: createLdClient() }).listen(port, () =>
    console.log(`demo-frontend on :${port}`),
  );
}
