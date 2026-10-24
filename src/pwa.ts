import { loadPreferences, savePreferences } from "./prefs";

/**
 * Install/update/offline affordances. The service worker is registered only in
 * production builds so the Vite dev server never serves stale modules.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installEvent: InstallPromptEvent | null = null;
let root: HTMLElement | null = null;
let updateAvailable = false;

function mount(): HTMLElement {
  if (root) return root;
  root = document.createElement("div");
  root.id = "pbc-pwa-root";
  document.body.appendChild(root);
  return root;
}

function render(): void {
  if (!root) return;
  const prefs = loadPreferences();
  const offline = !navigator.onLine;
  const showInstall = Boolean(installEvent) && !prefs.installDismissed;
  if (!offline && !showInstall && !updateAvailable) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = `
    ${offline ? `<div class="pbc-offline" role="status">Offline — guest editing and the browser library still work</div>` : ""}
    ${
      updateAvailable
        ? `<div class="pbc-pwa-card" role="status">
            <div class="pbc-pwa-text"><b>A new version is ready</b><span>Reload to pick up the latest fixes.</span></div>
            <button class="pbc-btn pbc-btn-primary pbc-btn-sm" data-pwa="reload">Reload</button>
          </div>`
        : ""
    }
    ${
      showInstall
        ? `<div class="pbc-pwa-card">
            <img src="/icons/icon-192.png" alt="" width="40" height="40" />
            <div class="pbc-pwa-text"><b>Install PowerBICraft</b><span>Open reports offline from your desktop or home screen.</span></div>
            <button class="pbc-btn pbc-btn-primary pbc-btn-sm" data-pwa="install">Install</button>
            <button class="pbc-icon-btn" data-pwa="dismiss" title="Not now">×</button>
          </div>`
        : ""
    }`;
}

async function registerWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          updateAvailable = true;
          render();
        }
      });
    });
    if (registration.waiting && navigator.serviceWorker.controller) {
      updateAvailable = true;
      render();
    }
  } catch {
    // Service workers are an enhancement; the app runs without them.
  }
}

export function registerPwa(): void {
  mount();
  window.addEventListener("online", render);
  window.addEventListener("offline", render);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event as InstallPromptEvent;
    render();
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    render();
  });

  root!.addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-pwa]");
    if (!target) return;
    const action = target.dataset.pwa;
    if (action === "install" && installEvent) {
      await installEvent.prompt();
      const choice = await installEvent.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      installEvent = null;
      if (choice.outcome === "dismissed") savePreferences({ installDismissed: true });
      render();
    } else if (action === "dismiss") {
      savePreferences({ installDismissed: true });
      render();
    } else if (action === "reload") {
      window.location.reload();
    }
  });

  if (import.meta.env.PROD) void registerWorker();
  render();
}
