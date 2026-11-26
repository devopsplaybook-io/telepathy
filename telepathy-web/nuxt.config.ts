// https://nuxt.com/docs/api/configuration/nuxt-config
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  ssr: false,
  app: {
    head: {
      charset: "utf-16",
      viewport:
        "width=device-width, initial-scale=1, height=device-height, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
      title: "Telepathy",
      meta: [
        { name: "description", content: "Telepathy" },
        { name: "theme-color", content: "#212121" },
      ],
      link: [
        { rel: "icon", href: "/icon.png" },
        { rel: "stylesheet", href: "/styles.css" },
      ],
    },
  },
  css: ["~/assets/css/main.css"],
  modules: ["@pinia/nuxt", "@vite-pwa/nuxt"],
  // common-web is consumed as raw .vue/.ts sources (not as a Nuxt layer, so its
  // global CSS does not leak here). Map the package to its installed directory
  // so both Vite and the generated tsconfig resolve the raw subpath imports.
  alias: {
    "@devopsplaybook.io/common-web": fileURLToPath(
      new URL("./node_modules/@devopsplaybook.io/common-web", import.meta.url),
    ),
  },
  // Raw sources must go through Vite's transform pipeline and stay out of
  // pre-bundling.
  build: {
    transpile: ["@devopsplaybook.io/common-web"],
  },
  vite: {
    optimizeDeps: {
      exclude: ["@devopsplaybook.io/common-web"],
    },
  },
  imports: {
    dirs: ["./stores"],
  },
  pinia: {
    autoImports: ["defineStore", "acceptHMRUpdate"],
  },
  pwa: {
    // Prompt mode keeps the old worker controlling until the user accepts the
    // shared update banner (components/AppUpdatePrompt.vue): a new build must
    // never silently reload the tab.
    registerType: "prompt",
    // Keep the sw.js fetch off the HTTP cache so a new build is noticed.
    updateViaCache: "none",
    name: "Telepathy",
    short_name: "Telepathy",
    lang: "en-US",
    start_url: "/tasks",
    display: "standalone",
    background_color: "white",
    theme_color: "#212121",
    icons: [
      {
        src: "images/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
    // @vite-pwa/nuxt 0.9 still exposes the generateSW settings under `workbox`.
    workbox: {
      // Never answer a navigation to the build manifest with the app shell.
      // (The module re-adds _nuxt/builds/latest.json to the precache through its
      // manifestTransforms, so detection cannot rely on excluding it; the probe
      // uses a cache-busting URL instead — see components/AppUpdatePrompt.vue.)
      navigateFallbackDenylist: [/\/_nuxt\/builds\//],
    },
  },
});
