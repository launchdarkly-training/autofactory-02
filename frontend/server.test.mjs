import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp, GREETING_EVENT_PATH, GREETING_REFRESH_FLAG } from "./server.mjs";

/**
 * Minimal stand-in for the LaunchDarkly client: serves a fixed variation value
 * and records the custom events the app emits.
 */
function fakeLdClient(variationValue, { throwOnVariation = false, throwOnTrack = false } = {}) {
  const events = [];
  return {
    events,
    evaluations: [],
    async variation(key, context, defaultValue) {
      this.evaluations.push({ key, context, defaultValue });
      if (throwOnVariation) throw new Error("LaunchDarkly unreachable");
      return variationValue;
    },
    track(eventKey, context, data, metricValue) {
      if (throwOnTrack) throw new Error("event pipeline down");
      events.push({ eventKey, context, metricValue });
    },
  };
}

async function withServer(ldClient, run) {
  const server = createApp({ ldClient }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const getPage = (ldClient) =>
  withServer(ldClient, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    return { status: res.status, html: await res.text() };
  });

const postBeacon = (ldClient, body) =>
  withServer(ldClient, async (baseUrl) => {
    const res = await fetch(baseUrl + GREETING_EVENT_PATH, { method: "POST", body });
    return { status: res.status };
  });

describe("greeting page variations", () => {
  it("serves the refresh control under v1", async () => {
    const { status, html } = await getPage(fakeLdClient("v1"));
    assert.equal(status, 200);
    assert.match(html, /<button id="refresh" type="button">Refresh greeting<\/button>/);
    assert.match(html, /addEventListener\("click", loadGreeting\)/);
  });

  it("serves the existing page under control", async () => {
    const { status, html } = await getPage(fakeLdClient("control"));
    assert.equal(status, 200);
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /loadGreeting/);
    assert.match(html, /<p id="greeting">Loading greeting from backend…<\/p>/);
  });

  it("evaluates the flag with a control fallback", async () => {
    const client = fakeLdClient("control");
    await getPage(client);
    assert.deepEqual(client.evaluations, [
      {
        key: GREETING_REFRESH_FLAG,
        context: { kind: "user", key: "demo-user" },
        defaultValue: "control",
      },
    ]);
  });
});

describe("fail-safe evaluation", () => {
  const controlCases = [
    ["no LaunchDarkly client", undefined],
    ["an unknown variation value", fakeLdClient("v2")],
    ["a non-string variation value", fakeLdClient(true)],
    ["a case-mismatched variation value", fakeLdClient("V1")],
    ["a throwing client", fakeLdClient("v1", { throwOnVariation: true })],
  ];

  for (const [label, client] of controlCases) {
    it(`falls back to the existing page with ${label}`, async () => {
      const { status, html } = await getPage(client);
      assert.equal(status, 200);
      assert.doesNotMatch(html, /<button/);
      assert.doesNotMatch(html, /loadGreeting/);
    });
  }

  it("keeps serving the page when event tracking throws", async () => {
    const { status, html } = await getPage(fakeLdClient("v1", { throwOnTrack: true }));
    assert.equal(status, 200);
    assert.match(html, /Refresh greeting/);
  });
});

describe("guarded-release events", () => {
  it("emits a numeric render-latency event on both variations", async () => {
    for (const variation of ["control", "v1"]) {
      const client = fakeLdClient(variation);
      await getPage(client);
      const latency = client.events.filter(
        (e) => e.eventKey === "shift2-enable-greeting-refresh-latency",
      );
      assert.equal(latency.length, 1, `expected one latency event under ${variation}`);
      assert.equal(typeof latency[0].metricValue, "number");
      assert.ok(latency[0].metricValue >= 0);
      assert.deepEqual(latency[0].context, { kind: "user", key: "demo-user" });
    }
  });

  it("only the v1 page reports greeting outcomes", async () => {
    const control = await getPage(fakeLdClient("control"));
    assert.doesNotMatch(control.html, new RegExp(GREETING_EVENT_PATH));
    const treatment = await getPage(fakeLdClient("v1"));
    assert.match(treatment.html, new RegExp(`sendBeacon\\("${GREETING_EVENT_PATH}"`));
  });

  const beaconCases = [
    ['{"outcome":"success"}', "shift2-enable-greeting-refresh-success"],
    ['{"outcome":"error"}', "shift2-enable-greeting-refresh-error"],
  ];

  for (const [body, expectedEventKey] of beaconCases) {
    it(`turns ${body} into ${expectedEventKey}`, async () => {
      const client = fakeLdClient("v1");
      const { status } = await postBeacon(client, body);
      assert.equal(status, 204);
      assert.deepEqual(
        client.events.map((e) => e.eventKey),
        [expectedEventKey],
      );
      assert.equal(client.events[0].metricValue, undefined);
    });
  }

  for (const body of ["not json at all", '{"outcome":"anything-else"}', ""]) {
    it(`emits no event for an unusable beacon body: ${JSON.stringify(body)}`, async () => {
      const client = fakeLdClient("v1");
      const { status } = await postBeacon(client, body);
      assert.equal(status, 204);
      assert.deepEqual(client.events, []);
    });
  }
});

describe("unflagged surfaces", () => {
  let statusBodies;

  before(async () => {
    statusBodies = [];
    for (const variation of ["control", "v1"]) {
      await withServer(fakeLdClient(variation), async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/status`);
        statusBodies.push(await res.json());
      });
    }
  });

  after(() => {
    statusBodies = undefined;
  });

  it("keeps the status contract identical across variations", () => {
    assert.deepEqual(statusBodies[0], statusBodies[1]);
    assert.equal(statusBodies[0].service, "demo-frontend");
  });
});
