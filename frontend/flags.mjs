/**
 * LaunchDarkly seam for the demo frontend.
 *
 * Mirrors backend/app.py's conventions: the client is created lazily, the
 * evaluation context is the demo's single hardcoded user, and every failure
 * path degrades to the caller's default rather than throwing.
 *
 * AutoFactory flags are string multivariate ("control" | "v1" | ...), so this
 * module exposes a variation-returning helper — never a boolean one. A boolean
 * helper would treat "control" as truthy and put every user on the new path.
 */

import { basicLogger, init } from "@launchdarkly/node-server-sdk";

const SDK_KEY = process.env.LD_SDK_KEY;

let client = null;

export function ldContext() {
  return { kind: "user", key: "demo-user" };
}

export function getLdClient() {
  if (client !== null || !SDK_KEY) {
    return client;
  }
  try {
    client = init(SDK_KEY, { logger: basicLogger({ level: "warn" }) });
    client.waitForInitialization({ timeout: 5 }).catch(() => {});
  } catch {
    client = null;
  }
  return client;
}

export async function stringVariation(ldClient, key, defaultValue = "control") {
  if (!ldClient) {
    return defaultValue;
  }
  try {
    const value = await ldClient.variation(key, ldContext(), defaultValue);
    return typeof value === "string" ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}
