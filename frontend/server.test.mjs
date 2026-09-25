/**
 * Flag-path tests for "enable-backend-status".
 *
 * The page template reads SHA and BACKEND_URL at module load, so the env is
 * cleared before the dynamic import to pin the expected control HTML.
 */

import assert from "node:assert/strict";
import test from "node:test";

delete process.env.RAILWAY_GIT_COMMIT_SHA;
delete process.env.BACKEND_URL;
delete process.env.LD_SDK_KEY;

const { createApp } = await import("./server.mjs");

/**
 * The page exactly as it rendered before the flag existed. The control
 * variation must keep producing this byte for byte.
 */
const CONTROL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>dev</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("http://localhost:8000/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;

function stubClient(variationValue) {
  const tracked = [];
  return {
    tracked,
    variation: async () => variationValue,
    track: (key, context, data, metricValue) => tracked.push({ key, context, data, metricValue }),
  };
}

async function withServer(ldClient, fn) {
  const server = await new Promise((resolve) => {
    const s = createApp({ ldClient }).listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const renderPage = (ldClient) =>
  withServer(ldClient, async (base) => (await fetch(base)).text());

test('control renders the pre-flag page exactly', async () => {
  assert.equal(await renderPage(stubClient("control")), CONTROL_HTML);
});

test('v1 renders the backend status line', async () => {
  const html = await renderPage(stubClient("v1"));
  assert.match(html, /<p id="backend-status">Checking backend status…<\/p>/);
  assert.match(html, /fetch\("http:\/\/localhost:8000\/api\/status"\)/);
  assert.match(html, /"Backend online: " \+ d\.service \+ " version " \+ d\.version/);
  assert.match(html, /"Backend offline"/);
});

test('v1 keeps the greeting behavior intact', async () => {
  const html = await renderPage(stubClient("v1"));
  assert.match(html, /fetch\("http:\/\/localhost:8000\/api\/greeting"\)/);
  assert.match(html, /"backend unavailable"/);
});

test('control falls back for every unavailable-or-unexpected evaluation', async () => {
  const fallbacks = {
    "no LaunchDarkly client": null,
    "client throws": {
      variation: async () => {
        throw new Error("LaunchDarkly unreachable");
      },
    },
    "non-string variation value": { variation: async () => true },
    "unknown future variation": { variation: async () => "v2" },
  };
  for (const [label, ldClient] of Object.entries(fallbacks)) {
    assert.equal(await renderPage(ldClient), CONTROL_HTML, label);
  }
});

test('control never emits the status beacon', async () => {
  const html = await renderPage(stubClient("control"));
  assert.ok(!html.includes("backend-status"));
  assert.ok(!html.includes("sendBeacon"));
});

test('a successful status check tracks success and latency', async () => {
  const client = stubClient("v1");
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/api/backend-status-event?outcome=ok&ms=42`, { method: "POST" });
    assert.equal(res.status, 204);
  });
  assert.deepEqual(
    client.tracked.map((t) => [t.key, t.metricValue]),
    [
      ["enable-backend-status-success", undefined],
      ["enable-backend-status-latency", 42],
    ],
  );
  assert.deepEqual(client.tracked[0].context, { kind: "user", key: "demo-user" });
});

test('a failed status check tracks error and latency', async () => {
  const client = stubClient("v1");
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/api/backend-status-event?outcome=error&ms=5000`, { method: "POST" });
    assert.equal(res.status, 204);
  });
  assert.deepEqual(
    client.tracked.map((t) => [t.key, t.metricValue]),
    [
      ["enable-backend-status-error", undefined],
      ["enable-backend-status-latency", 5000],
    ],
  );
});

test('a malformed beacon tracks nothing and still succeeds', async () => {
  const client = stubClient("v1");
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/api/backend-status-event?outcome=&ms=not-a-number`, { method: "POST" });
    assert.equal(res.status, 204);
  });
  assert.deepEqual(client.tracked, []);
});

test('a tracking failure does not fail the request', async () => {
  const client = {
    variation: async () => "v1",
    track: () => {
      throw new Error("event pipeline down");
    },
  };
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/api/backend-status-event?outcome=ok&ms=1`, { method: "POST" });
    assert.equal(res.status, 204);
  });
});
