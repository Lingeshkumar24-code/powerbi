import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Model, ReportDoc, Table } from "./types";

/**
 * Guest storage. Datasets and projects live in IndexedDB; localStorage is kept
 * for tiny UI preferences only (see prefs.ts). Nothing here talks to a server,
 * so the workbench stays fully usable without an account.
 */
export interface StoredProject {
  id: string;
  name: string;
  model: Model;
  report: ReportDoc;
  createdAt: number;
  updatedAt: number;
  autosave?: boolean;
}

export interface StoredDataset {
  id: string;
  name: string;
  sourceName: string;
  kind: "csv" | "json" | "xlsx" | "tsv" | "unknown";
  tables: Table[];
  createdAt: number;
  updatedAt: number;
}

interface Schema extends DBSchema {
  projects: { key: string; value: StoredProject; indexes: { updatedAt: number } };
  datasets: { key: string; value: StoredDataset; indexes: { updatedAt: number } };
  meta: { key: string; value: { key: string; value: unknown } };
}

const DB_NAME = "powerbicraft";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<Schema> | null> | null = null;

function storageAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function db(): Promise<IDBPDatabase<Schema> | null> {
  if (!storageAvailable()) return Promise.resolve(null);
  dbPromise ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("projects")) {
        const store = database.createObjectStore("projects", { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains("datasets")) {
        const store = database.createObjectStore("datasets", { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains("meta")) {
        database.createObjectStore("meta", { keyPath: "key" });
      }
    },
  }).catch(() => null);
  return dbPromise;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function listProjects(): Promise<StoredProject[]> {
  const store = (await db())?.transaction("projects").store;
  if (!store) return [];
  const rows = await store.getAll();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProjectRecord(id: string): Promise<StoredProject | undefined> {
  const store = (await db())?.transaction("projects").store;
  return store?.get(id);
}

export async function saveProjectRecord(
  name: string,
  model: Model,
  report: ReportDoc,
  id?: string,
): Promise<StoredProject | null> {
  const database = await db();
  if (!database) return null;
  const now = Date.now();
  const existing = id ? await database.get("projects", id) : undefined;
  const record: StoredProject = {
    id: existing?.id ?? id ?? newId("prj"),
    name: name.trim() || report.name || "Untitled report",
    model,
    report,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    autosave: false,
  };
  await database.put("projects", record);
  return record;
}

export async function deleteProjectRecord(id: string): Promise<void> {
  const database = await db();
  if (database) await database.delete("projects", id);
}

const AUTOSAVE_ID = "autosave";

export async function saveAutosave(model: Model, report: ReportDoc): Promise<void> {
  const database = await db();
  if (!database) return;
  const now = Date.now();
  await database.put("projects", {
    id: AUTOSAVE_ID,
    name: report.name || "Untitled report",
    model,
    report,
    createdAt: now,
    updatedAt: now,
    autosave: true,
  });
}

export async function getAutosave(): Promise<StoredProject | undefined> {
  const database = await db();
  return database?.get("projects", AUTOSAVE_ID);
}

export async function listDatasets(): Promise<StoredDataset[]> {
  const database = await db();
  if (!database) return [];
  const rows = await database.getAll("datasets");
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveDataset(
  name: string,
  sourceName: string,
  kind: StoredDataset["kind"],
  tables: Table[],
): Promise<StoredDataset | null> {
  const database = await db();
  if (!database) return null;
  const now = Date.now();
  const record: StoredDataset = {
    id: newId("ds"),
    name: name.trim() || sourceName,
    sourceName,
    kind,
    tables,
    createdAt: now,
    updatedAt: now,
  };
  await database.put("datasets", record);
  return record;
}

export async function deleteDataset(id: string): Promise<void> {
  const database = await db();
  if (database) await database.delete("datasets", id);
}

export async function getDataset(id: string): Promise<StoredDataset | undefined> {
  const database = await db();
  return database?.get("datasets", id);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

export async function clearGuestData(): Promise<void> {
  const database = await db();
  if (!database) return;
  await database.clear("projects");
  await database.clear("datasets");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}
