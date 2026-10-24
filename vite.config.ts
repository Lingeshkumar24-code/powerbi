import { defineConfig } from "vite";

// The app ships two entries: the authoring workbench (index.html) and the
// read-only viewer that share links, embeds and snapshots load.
export default defineConfig({
  server: {
    port: 5178,
    proxy: {
      // Normalise Origin/Host for JSON writes. The service checks Origin
      // against Host or PBC_PUBLIC_URL; without this, a browser page on 5178
      // proxied to 5180 would be rejected as cross-origin during normal dev.
      "/api": {
        target: "http://127.0.0.1:5180",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", "http://127.0.0.1:5180");
          });
        },
      },
      "/v": "http://127.0.0.1:5180",
      "/e": "http://127.0.0.1:5180",
      // The viewer iframe is served from the production build by the API, so
      // its hashed /assets/* files come from there too. Vite's own authoring
      // app imports .ts modules directly and never uses /assets in dev.
      "/assets": "http://127.0.0.1:5180",
    },
    // Server-side artifacts (SQLite WAL, snapshots, headless-browser profiles)
    // must never be watched: Chromium keeps its cache files locked.
    watch: {
      ignored: ["**/data/**", "**/dist/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        viewer: "viewer.html",
      },
    },
  },
});
