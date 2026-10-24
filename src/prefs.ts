/**
 * localStorage is deliberately limited to small UI preferences. Projects and
 * datasets never live here (see storage.ts).
 */
export interface Preferences {
  zoom: number;
  showInspector: boolean;
  restoreLast: boolean;
  installDismissed: boolean;
  libraryHintSeen: boolean;
}

const KEY = "pbc.prefs.v1";

const DEFAULTS: Preferences = {
  zoom: 0,
  showInspector: true,
  restoreLast: true,
  installDismissed: false,
  libraryHintSeen: false,
};

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      zoom: typeof parsed.zoom === "number" && parsed.zoom >= 0 && parsed.zoom <= 2 ? parsed.zoom : DEFAULTS.zoom,
      showInspector: typeof parsed.showInspector === "boolean" ? parsed.showInspector : DEFAULTS.showInspector,
      restoreLast: typeof parsed.restoreLast === "boolean" ? parsed.restoreLast : DEFAULTS.restoreLast,
      installDismissed:
        typeof parsed.installDismissed === "boolean" ? parsed.installDismissed : DEFAULTS.installDismissed,
      libraryHintSeen:
        typeof parsed.libraryHintSeen === "boolean" ? parsed.libraryHintSeen : DEFAULTS.libraryHintSeen,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = { ...loadPreferences(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or privacy mode: preferences are optional.
  }
  return next;
}
