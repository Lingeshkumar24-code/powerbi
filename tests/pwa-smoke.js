/**
 * PowerBICraft PWA smoke suite.
 *
 * Run against the production build served by the API (npm run build, then the
 * test API), because the service worker is deliberately disabled in dev:
 *
 *   await runPowerBICraftPwaSmoke()
 *
 * Checks the installable manifest, service worker, offline shell cache and the
 * responsive stylesheet. It does not install the app or emulate a mobile
 * viewport; those remain manual checks.
 */
window.runPowerBICraftPwaSmoke = async function runPowerBICraftPwaSmoke() {
  const results = [];
  const ok = (name, cond, extra) =>
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, label, ms = 15000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = await fn();
      if (value) return value;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  try {
    ok("page is a secure context", window.isSecureContext);
    const manifestLink = document.querySelector('link[rel="manifest"]');
    ok("manifest is linked", !!manifestLink, manifestLink && manifestLink.getAttribute("href"));
    const manifestResponse = await fetch(manifestLink.getAttribute("href"));
    const manifest = await manifestResponse.json();
    ok("manifest is served", manifestResponse.status === 200, manifestResponse.status);
    ok("manifest names the app", manifest.name === "PowerBICraft" && manifest.short_name === "PowerBICraft");
    ok("manifest declares a standalone display", manifest.display === "standalone");
    ok("manifest has a root start URL", /^\/(\?.*)?$/.test(manifest.start_url), manifest.start_url);
    ok("manifest has a root scope", manifest.scope === "/", manifest.scope);
    ok("manifest has 192 and 512 icons", [192, 512].every((size) => manifest.icons.some((i) => i.sizes === `${size}x${size}`)));
    ok(
      "manifest has maskable icons",
      [192, 512].every((size) =>
        manifest.icons.some((i) => i.sizes === `${size}x${size}` && String(i.purpose).includes("maskable")),
      ),
    );
    ok(
      "manifest has library and AI shortcuts",
      ["/?library=1", "/?ai=1"].every((url) => manifest.shortcuts.some((s) => s.url === url)),
    );
    ok("theme color is declared", !!document.querySelector('meta[name="theme-color"]'));
    for (const icon of manifest.icons) {
      const response = await fetch(icon.src);
      const blob = await response.blob();
      ok(`icon ${icon.src} is served`, response.status === 200 && blob.size > 0, { status: response.status, bytes: blob.size });
    }

    const registration = await waitFor(
      () => navigator.serviceWorker.getRegistration(),
      "service worker registration",
    );
    ok("service worker is registered", !!registration, registration && (registration.active || registration.installing || registration.waiting));
    const controller = await waitFor(() => navigator.serviceWorker.controller, "active service worker", 20000);
    ok("service worker controls the page", /\/sw\.js$/.test(controller.scriptURL), controller.scriptURL);

    const cacheNames = await caches.keys();
    const shell = cacheNames.find((name) => name.startsWith("pbc-shell-"));
    ok("shell cache exists", !!shell, cacheNames);
    const cache = shell ? await caches.open(shell) : null;
    const cached = cache ? (await cache.keys()).map((request) => new URL(request.url).pathname) : [];
    ok("app shell is cached", cached.includes("/"), cached);
    ok("offline page is cached", cached.includes("/offline.html"), cached);
    const offline = await fetch("/offline.html");
    ok("offline page is served", offline.status === 200 && /offline/i.test(await offline.text()));

    const cssHref = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((link) => link.getAttribute("href"))
      .find((href) => href && href.includes("styles"));
    const css = cssHref ? await fetch(cssHref).then((r) => r.text()) : "";
    ok("responsive 900px breakpoint ships", css.includes("@media (max-width: 900px)"));
    ok("responsive 760px breakpoint ships", css.includes("@media (max-width: 760px)"));
    ok("install/offline host is mounted", !!document.getElementById("pbc-pwa-root"));
  } catch (error) {
    ok("suite completed without throwing", false, String(error));
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    suite: "pwa",
    passed,
    failed: results.filter((r) => !r.pass),
    total: results.length,
    results,
  };
};
