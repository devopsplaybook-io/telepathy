// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

interface WorkboxConfig {
  navigateFallbackDenylist?: RegExp[];
  skipWaiting?: boolean;
  clientsClaim?: boolean;
}

interface PwaConfig {
  registerType?: string;
  updateViaCache?: string;
  name?: string;
  start_url?: string;
  workbox?: WorkboxConfig;
}

interface NuxtConfig {
  alias?: Record<string, string>;
  build?: { transpile?: string[] };
  pwa?: PwaConfig;
}

function blocksBuildManifest(denylist: RegExp[], url: string): boolean {
  return denylist.some((pattern) => pattern.test(url));
}

describe("nuxt.config PWA prompt mode", () => {
  let config: NuxtConfig;

  beforeAll(async () => {
    // nuxt.config.ts calls the Nuxt global; stub it for the plain import
    (globalThis as Record<string, unknown>).defineNuxtConfig ??= (
      value: unknown,
    ) => value;
    config = (await import("../nuxt.config")).default as NuxtConfig;
  });

  it("waits for the user before activating a new build", () => {
    expect(config.pwa?.registerType).toBe("prompt");
    expect(config.pwa?.updateViaCache).toBe("none");
    expect(config.pwa?.workbox?.skipWaiting).toBeUndefined();
    expect(config.pwa?.workbox?.clientsClaim).toBeUndefined();
  });

  it("keeps the generated manifest metadata", () => {
    expect(config.pwa?.name).toBe("Telepathy");
    expect(config.pwa?.start_url).toBe("/tasks");
  });

  it("never answers a build-manifest navigation with the app shell", () => {
    const denylist = config.pwa?.workbox?.navigateFallbackDenylist ?? [];
    expect(blocksBuildManifest(denylist, "/_nuxt/builds/latest.json")).toBe(
      true,
    );
    expect(blocksBuildManifest(denylist, "/_nuxt/entry.js")).toBe(false);
  });

  it("consumes common-web raw sources through Vite", () => {
    expect(config.alias?.["@devopsplaybook.io/common-web"]).toContain(
      "node_modules/@devopsplaybook.io/common-web",
    );
    expect(config.build?.transpile).toContain(
      "@devopsplaybook.io/common-web",
    );
  });
});
