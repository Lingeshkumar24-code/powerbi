import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGuestData,
  deleteDataset,
  deleteProjectRecord,
  formatBytes,
  getAutosave,
  getDataset,
  getProjectRecord,
  listDatasets,
  listProjects,
  saveAutosave,
  saveDataset,
  saveProjectRecord,
} from "../src/storage";
import { loadPreferences, savePreferences } from "../src/prefs";
import type { Model, ReportDoc } from "../src/types";

const model: Model = {
  tables: [
    {
      name: "Sales",
      columns: [
        { name: "Region", type: "string" },
        { name: "Amount", type: "number" },
      ],
      rows: [
        { Region: "US", Amount: 10 },
        { Region: "CA", Amount: 20 },
      ],
    },
  ],
  measures: [],
  relationships: [],
};

const report: ReportDoc = {
  version: 1,
  name: "Browser report",
  activePage: "p1",
  pages: [{ id: "p1", name: "Page 1", background: "#fff", visuals: [] }],
};

beforeEach(async () => {
  await clearGuestData();
});

describe("IndexedDB project and dataset storage", () => {
  it("saves, lists, updates and reopens a project", async () => {
    const first = await saveProjectRecord("Quarterly", model, report);
    expect(first?.id).toBeTruthy();
    const listed = await listProjects();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Quarterly", autosave: false });

    const updated = await saveProjectRecord("Quarterly v2", model, { ...report, name: "Quarterly v2" }, first!.id);
    expect(updated!.id).toBe(first!.id);
    expect((await getProjectRecord(first!.id))!.name).toBe("Quarterly v2");
    expect(await listProjects()).toHaveLength(1);

    await deleteProjectRecord(first!.id);
    expect(await listProjects()).toHaveLength(0);
  });

  it("keeps a separate autosave record and replaces it in place", async () => {
    await saveAutosave(model, report);
    const one = await getAutosave();
    expect(one).toMatchObject({ id: "autosave", name: "Browser report", autosave: true });

    await saveAutosave(model, { ...report, name: "Edited" });
    const two = await getAutosave();
    expect(two!.name).toBe("Edited");
    expect(await listProjects()).toHaveLength(1);
  });

  it("stores datasets with their parsed tables", async () => {
    const saved = await saveDataset("Sales file", "sales.csv", "csv", model.tables);
    expect(saved).toBeTruthy();
    const listed = await listDatasets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Sales file", kind: "csv", sourceName: "sales.csv" });
    expect(listed[0].tables[0].rows).toHaveLength(2);
    expect((await getDataset(saved!.id))!.tables[0].name).toBe("Sales");
    await deleteDataset(saved!.id);
    expect(await listDatasets()).toHaveLength(0);
  });

  it("formats byte counts for the storage footer", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("localStorage preferences", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("falls back to defaults when absent or corrupt", () => {
    expect(loadPreferences().restoreLast).toBe(true);
    store.set("pbc.prefs.v1", "{not json");
    expect(loadPreferences().showInspector).toBe(true);
  });

  it("persists only UI preferences", () => {
    savePreferences({ zoom: 1.2, showInspector: false, restoreLast: false });
    expect(loadPreferences()).toMatchObject({ zoom: 1.2, showInspector: false, restoreLast: false });
    const raw = store.get("pbc.prefs.v1")!;
    expect(raw).not.toContain("tables");
    expect(raw.length).toBeLessThan(500);
  });

  it("clamps invalid zoom values", () => {
    store.set("pbc.prefs.v1", JSON.stringify({ zoom: 99 }));
    expect(loadPreferences().zoom).toBe(0);
  });
});
