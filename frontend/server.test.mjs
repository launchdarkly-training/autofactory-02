/**
 * Flag-path tests for "enable-backend-status".
 *
 * Scope is the flagged behavior only: the control path must render the page
 * exactly as it did before the flag existed, and the v1 path must render the
 * backend status line and emit the guarded-release events.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createApp, FLAG_BACKEND_STATUS } from "./server.mjs";

/** An LD client stub that records evaluations and tracked events. */
function stubClient({ variationValue = "control", throwOnVariation = false } = {}) {
  const evaluations = [];
  const tracked = [];
  return {
    evaluations,
    tracked,
    variation(key, context, defaultValue) {
      evaluations.push({ key, context, defaultValue });
      if (throwOnVariation) throw new Error("LaunchDarkly unreachable");
      return variationValue;
    },
    track(key, context, data, metricValue) {
      tracked.push({ key, context, metricValue });
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

function getPage(options) {
  return withServer(createApp(options), (base) => fetch(base).then((r) => r.text()));
}

function postOutcome(options, body) {
  return withServer(createApp(options), async (base) => {
    const res = await fetch(`${base}/api/backend-status-outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  });
}

test('control renders the page without the backend status line', async () => {
  const html = await getPage({ ldClient: stubClient({ variationValue: "control" }) });

  assert.doesNotMatch(html, /backend-status/);
  assert.doesNotMatch(html, /api\/status/);
  assert.doesNotMatch(html, /sendBeacon/);
  assert.match(html, /<p id="greeting">/);
});

test('v1 renders the backend status line and beacons its outcome', async () => {
  const html = await getPage({ ldClient: stubClient({ variationValue: "v1" }) });

  assert.match(html, /<p id="backend-status">Checking backend status…<\/p>/);
  assert.match(html, /fetch\("http:\/\/localhost:8000\/api\/status"\)/);
  assert.match(html, /Backend online: /);
  assert.match(html, /Backend offline/);
  assert.match(html, /navigator\.sendBeacon\("\/api\/backend-status-outcome"/);
});

test('v1 is a strict superset of control — it adds the status line, changes nothing else', async () => {
  const control = await getPage({ ldClient: stubClient({ variationValue: "control" }) });
  const treatment = await getPage({ ldClient: stubClient({ variationValue: "v1" }) });

  assert.notEqual(control, treatment);
  for (const line of control.split("\n")) {
    assert.ok(treatment.includes(line), `v1 page dropped a control line: ${line}`);
  }
});

test('the flag is evaluated with a fail-safe "control" default', async () => {
  const client = stubClient({ variationValue: "v1" });
  await getPage({ ldClient: client });

  assert.equal(client.evaluations.length, 1);
  assert.equal(client.evaluations[0].key, FLAG_BACKEND_STATUS);
  assert.equal(client.evaluations[0].defaultValue, "control");
  assert.deepEqual(client.evaluations[0].context, { kind: "user", key: "demo-user" });
});

test('no LaunchDarkly client falls back to control', async () => {
  const html = await getPage({ ldClient: null });
  assert.doesNotMatch(html, /backend-status/);
});

test('an evaluation error falls back to control', async () => {
  const html = await getPage({ ldClient: stubClient({ throwOnVariation: true }) });
  assert.doesNotMatch(html, /backend-status/);
});

test('a non-string variation value falls back to control (no boolean-helper trap)', async () => {
  for (const variationValue of [true, 1, {}]) {
    const html = await getPage({ ldClient: stubClient({ variationValue }) });
    assert.doesNotMatch(html, /backend-status/, `truthy ${typeof variationValue} took the v1 path`);
  }
});

test('an unknown future variation falls back to control', async () => {
  const html = await getPage({ ldClient: stubClient({ variationValue: "v2" }) });
  assert.doesNotMatch(html, /backend-status/);
});

test('a successful beacon tracks latency and success', async () => {
  const client = stubClient();
  const status = await postOutcome({ ldClient: client }, { ok: true, elapsedMs: 42 });

  assert.equal(status, 204);
  assert.deepEqual(
    client.tracked.map((t) => [t.key, t.metricValue]),
    [
      ["enable-backend-status-latency", 42],
      ["enable-backend-status-success", undefined],
    ],
  );
  assert.deepEqual(client.tracked[0].context, { kind: "user", key: "demo-user" });
});

test('a failed beacon tracks latency and error', async () => {
  const client = stubClient();
  const status = await postOutcome({ ldClient: client }, { ok: false, elapsedMs: 1337 });

  assert.equal(status, 204);
  assert.deepEqual(
    client.tracked.map((t) => t.key),
    ["enable-backend-status-latency", "enable-backend-status-error"],
  );
});

test('an unusable duration is dropped but the outcome is still tracked', async () => {
  for (const elapsedMs of ["not-a-number", -1, 60001, null]) {
    const client = stubClient();
    const status = await postOutcome({ ldClient: client }, { ok: true, elapsedMs });

    assert.equal(status, 204);
    assert.deepEqual(
      client.tracked.map((t) => t.key),
      ["enable-backend-status-success"],
      `elapsedMs ${JSON.stringify(elapsedMs)} was tracked as a latency value`,
    );
  }
});

test('telemetry failures never fail the beacon request', async () => {
  const client = stubClient();
  client.track = () => {
    throw new Error("event queue full");
  };

  assert.equal(await postOutcome({ ldClient: client }, { ok: true, elapsedMs: 10 }), 204);
  assert.equal(await postOutcome({ ldClient: null }, { ok: true, elapsedMs: 10 }), 204);
});
