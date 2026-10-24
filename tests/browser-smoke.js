/**
 * PowerBICraft browser smoke suite.
 *
 * Unit tests (npm test) cover the engine, DAX, importers and package I/O.
 * This suite drives the real UI in a browser: rendering, cross-filtering,
 * slicers, authoring, measures, imports and .pbix round-tripping.
 *
 * Usage: open the app (npm run dev), then paste this file into DevTools and run
 *
 *     await runPowerBICraftSmoke()
 *
 * Every section resets the demo model first, so the app is left clean.
 */
window.runPowerBICraftSmoke = async function runPowerBICraftSmoke() {
  const api = window.powerbicraft;
  if (!api) throw new Error("PowerBICraft is not loaded on this page");

  const results = [];
  const ok = (name, cond, extra) =>
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
  const click = (el) => {
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!el;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = () =>
    api.state.report.pages.find((p) => p.id === api.state.report.activePage);
  const card = () => page().visuals.find((v) => v.type === "card");
  const reset = () => {
    click(document.querySelector('[data-action="reset-demo"]'));
    api.state.filters.clear();
    api.state.selection = null;
    api.state.selectedVisualId = null;
    api.render();
  };
  const openDetails = () =>
    document.querySelectorAll(".pbc-table-node").forEach((d) => {
      d.open = true;
    });
  const dragDrop = (fieldKey, role) => {
    openDetails();
    const field = document.querySelector(`[data-field="${fieldKey}"]`);
    const well = document.querySelector(`[data-well="${role}"]`);
    if (!field || !well) return false;
    const dt = new DataTransfer();
    field.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    well.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    well.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  };
  const idbAll = (store) =>
    new Promise((resolve) => {
      const request = indexedDB.open("powerbicraft");
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) {
          resolve([]);
          return;
        }
        const all = db.transaction(store, "readonly").objectStore(store).getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      };
    });
  const waitFor = async (fn, label, ms = 10000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  // ======================================================= rendering + context
  reset();
  ok("demo has two pages", api.state.report.pages.length === 2, api.state.report.pages.length);
  ok("page 1 renders 11 visuals", page().visuals.length === 11, page().visuals.length);
  ok(
    "page 1 builds 11 frames",
    document.querySelectorAll(".pbc-visual").length === 11,
    document.querySelectorAll(".pbc-visual").length,
  );
  ok(
    "chart SVGs rendered",
    document.querySelectorAll("svg.pbc-svg").length === 3,
    document.querySelectorAll("svg.pbc-svg").length,
  );
  ok(
    "table rows rendered",
    document.querySelectorAll(".pbc-table tbody tr").length > 0,
    document.querySelectorAll(".pbc-table tbody tr").length,
  );

  const baseCard = api.buildVisualData(card()).card.value;
  ok("card shows total revenue", baseCard.includes("502,899,064"), baseCard);

  const page2 = api.state.report.pages[1].id;
  click(document.querySelector(`[data-page="${page2}"]`));
  ok("switch to page 2", api.state.report.activePage === page2, api.state.report.activePage);
  ok(
    "matrix renders on page 2",
    document.querySelectorAll(".pbc-matrix tbody tr").length > 0,
    document.querySelectorAll(".pbc-matrix tbody tr").length,
  );
  click(document.querySelector(`[data-page="${api.state.report.pages[0].id}"]`));
  ok("switch back", api.state.report.activePage === api.state.report.pages[0].id);

  const mark = document.querySelector(".pbc-visual [data-cf-val]");
  const markValue = mark && mark.getAttribute("data-cf-val");
  click(mark);
  ok(
    "cross-filter selection recorded",
    !!api.state.selection && api.state.selection.value === markValue,
    api.state.selection && api.state.selection.value,
  );
  const filteredCard = api.buildVisualData(card()).card.value;
  ok("cross-filter changes measures", filteredCard !== baseCard, { baseCard, filteredCard });
  ok("filter bar appears", !!document.querySelector(".pbc-filterbar"));
  ok("selection chip appears", !!document.querySelector(".pbc-chip-sel"));
  click(document.querySelector("[data-clear-selection]"));
  ok("cross-filter clears", api.state.selection === null);
  ok("card restored", api.buildVisualData(card()).card.value === baseCard);

  const slicerItem = document.querySelector(".pbc-slicer-item");
  const slicerValue = slicerItem.getAttribute("data-slicer-value");
  click(slicerItem);
  ok("slicer filter applied", api.state.filters.size === 1, [...api.state.filters.keys()]);
  ok(
    "slicer changes measures",
    api.buildVisualData(card()).card.value !== baseCard,
    api.buildVisualData(card()).card.value,
  );
  ok("slicer shows selection", !!document.querySelector(".pbc-slicer-item.selected"));
  click(document.querySelector("[data-clear-filter]"));
  ok("slicer filter cleared", api.state.filters.size === 0);
  ok("card restored after slicer", api.buildVisualData(card()).card.value === baseCard);
  void slicerValue;

  const z0 = document.getElementById("zoom-label").textContent;
  click(document.querySelector('[data-action="zoom-in"]'));
  const z1 = document.getElementById("zoom-label").textContent;
  click(document.querySelector('[data-action="zoom-out"]'));
  const z2 = document.getElementById("zoom-label").textContent;
  click(document.querySelector('[data-action="zoom-fit"]'));
  const z3 = document.getElementById("zoom-label").textContent;
  ok("zoom in", parseInt(z1) > parseInt(z0), [z0, z1]);
  ok("zoom out", parseInt(z2) < parseInt(z1), [z1, z2]);
  ok("zoom fit", parseInt(z3) === parseInt(z0), [z0, z3]);

  // ======================================================= authoring
  reset();
  if (!api.state.showInspector)
    click(document.querySelector('[data-action="toggle-inspector"]'));
  ok("visual gallery opens", !!document.querySelector(".pbc-viz-grid"));

  const types = [...document.querySelectorAll('[data-action="add-visual"]')].map(
    (b) => b.dataset.type,
  );
  ok("gallery exposes 14 types", types.length === 14, types.length);
  for (const t of types) {
    click(document.querySelector('[data-action="deselect"]'));
    click(document.querySelector(`[data-action="add-visual"][data-type="${t}"]`));
    const added = page().visuals[page().visuals.length - 1];
    const frame = document.querySelector(`.pbc-visual[data-visual="${added.id}"]`);
    ok(
      `add ${t}`,
      added.type === t && !!frame && !!frame.querySelector(".pbc-visual-body").innerHTML,
    );
  }

  click(document.querySelector('[data-action="deselect"]'));
  click(document.querySelector('[data-action="add-visual"][data-type="column"]'));
  const viz = page().visuals[page().visuals.length - 1];
  ok("drop column into Category", dragDrop("Geography[Region]", "category") && viz.wells.category.includes("Geography[Region]"), viz.wells.category);
  ok("drop measure into Values", dragDrop("[Total Revenue]", "values") && viz.wells.values.includes("[Total Revenue]"), viz.wells.values);
  const built = api.buildVisualData(viz);
  ok(
    "bound visual queries data",
    built.categories.length === 4 && built.series[0].values.some((v) => v > 0),
    { categories: built.categories.length, first: built.series[0] && built.series[0].values[0] },
  );
  ok(
    "bound chart draws marks",
    document.querySelectorAll(`.pbc-visual[data-visual="${viz.id}"] .pbc-mark`).length > 0,
  );

  const title = document.getElementById("visual-title");
  title.value = "Revenue by market";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  ok("title edit", viz.title === "Revenue by market", viz.title);

  const typeSelect = document.getElementById("visual-type");
  typeSelect.value = "bar";
  typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  ok("type switch to bar", viz.type === "bar", viz.type);
  ok(
    "bar draws 4 marks",
    document.querySelectorAll(`.pbc-visual[data-visual="${viz.id}"] .pbc-mark`).length === 4,
  );

  const topN = document.getElementById("visual-topn");
  topN.value = "3";
  topN.dispatchEvent(new Event("change", { bubbles: true }));
  ok("top N limits categories", api.buildVisualData(viz).categories.length === 3, api.buildVisualData(viz).categories);

  const sort = document.getElementById("visual-sort");
  sort.value = "value";
  sort.dispatchEvent(new Event("change", { bubbles: true }));
  const vals = api.buildVisualData(viz).series[0].values;
  ok("sort by value desc", vals[0] >= vals[1] && vals[1] >= vals[2], vals);

  const legend = document.getElementById("visual-legend");
  legend.checked = true;
  legend.dispatchEvent(new Event("change", { bubbles: true }));
  ok("legend toggle", viz.showLegend === true);

  const labels = document.getElementById("visual-labels");
  labels.checked = true;
  labels.dispatchEvent(new Event("change", { bubbles: true }));
  ok("data label toggle", viz.showLabels === true);

  const before = page().visuals.length;
  click(document.querySelector(`.pbc-visual[data-visual="${viz.id}"] [data-action="duplicate-visual"]`));
  ok("duplicate visual", page().visuals.length === before + 1, page().visuals.length);
  const dup = page().visuals[page().visuals.length - 1];
  click(document.querySelector(`.pbc-visual[data-visual="${dup.id}"] [data-action="delete-visual"]`));
  ok("delete visual", page().visuals.length === before, page().visuals.length);

  const pagesBefore = api.state.report.pages.length;
  click(document.querySelector('[data-action="add-page"]'));
  ok("add page", api.state.report.pages.length === pagesBefore + 1, api.state.report.pages.length);
  const newPage = api.state.report.activePage;
  ok("new page is empty", page().visuals.length === 0);
  click(document.querySelector(`[data-page="${newPage}"] [data-action="del-page"]`));
  ok("delete page", api.state.report.pages.length === pagesBefore, api.state.report.pages.length);

  // ======================================================= measures
  reset();
  click(document.querySelector('[data-action="measures"]'));
  ok("measure editor lists 8 measures", document.querySelectorAll(".pbc-measure-row").length === 8);
  let statuses = [...document.querySelectorAll(".pbc-measure-status")].map((el) => el.textContent.trim());
  ok("bundled measures validate", statuses.every((s) => s.startsWith("✓")), statuses);

  click(document.querySelector('[data-action="add-measure"]'));
  ok("add measure", document.querySelectorAll(".pbc-measure-row").length === 9);

  let ta = document.querySelector('[data-measure-expr="8"]');
  ta.value = "SUM(Sales[Nope]";
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(30);
  ok(
    "invalid DAX reports an error",
    document.querySelector('[data-measure-status="8"]').textContent.trim().startsWith("✕"),
    document.querySelector('[data-measure-status="8"]').textContent.trim(),
  );

  ta = document.querySelector('[data-measure-expr="8"]');
  ta.value = "AVERAGE(Sales[Units])";
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(30);
  ok(
    "valid DAX reports a value",
    document.querySelector('[data-measure-status="8"]').textContent.trim().startsWith("✓"),
    document.querySelector('[data-measure-status="8"]').textContent.trim(),
  );

  click(document.querySelector('[data-action="delete-measure"][data-index="8"]'));
  ok("delete measure", document.querySelectorAll(".pbc-measure-row").length === 8);
  click(document.querySelector('.pbc-modal-actions [data-action="close-modal"]'));
  ok("measure editor closes", !document.querySelector(".pbc-overlay"));

  // ======================================================= data + interop
  const input = document.getElementById("file-input");
  const csv =
    "City,Population,Country,Listed\nParis,2100000,France,2024-01-02\nBerlin,3600000,Germany,2024-03-04\nOslo,700000,Norway,2024-05-06\n";
  const dt = new DataTransfer();
  dt.items.add(new File([csv], "cities.csv", { type: "text/csv" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);
  const cities = api.state.model.tables.find((t) => t.name === "cities");
  ok("CSV import adds 3 rows", !!cities && cities.rows.length === 3, cities ? cities.rows.length : null);
  ok(
    "CSV types inferred",
    !!cities && cities.columns.map((c) => c.type).join(",") === "string,number,string,date",
    cities ? cities.columns.map((c) => c.type) : null,
  );

  const pbix = await import("/src/pbix.ts");

  const projectBytes = pbix.saveProject(api.state.model, api.state.report);
  await api.openProjectFile(new File([projectBytes], "roundtrip.pbc"));
  ok("project reopens 5 tables", api.state.model.tables.length === 5, api.state.model.tables.length);
  ok("project reopens 2 pages", api.state.report.pages.length === 2, api.state.report.pages.length);

  const tableVisual = page().visuals.find((v) => v.type === "table");
  ok("top N honoured on demo table", api.buildVisualData(tableVisual).rows.length === 7, api.buildVisualData(tableVisual).rows.length);

  const pbirBytes = pbix.exportPbir(api.state.report, api.state.model);
  click(document.querySelector('[data-action="export-pbir"]'));
  ok(
    "export button reports success",
    document.querySelector(".pbc-status").textContent.includes("PBIR"),
    document.querySelector(".pbc-status").textContent,
  );

  await api.openPbixFile(new File([pbirBytes], "contoso.pbix"));
  ok(
    "pbix package recognised as PBIR",
    !!api.state.pbixInfo && api.state.pbixInfo.format === "pbir",
    api.state.pbixInfo && api.state.pbixInfo.format,
  );
  ok("package modal lists parts", document.querySelectorAll(".pbc-parts code").length >= 10);
  click(document.querySelector('.pbc-modal-actions [data-action="close-modal"]'));
  ok("imported report keeps 2 pages", api.state.report.pages.length === 2);
  const importedCard = page().visuals.find((v) => v.type === "card");
  ok(
    "imported fields rebind to the model",
    importedCard && api.buildVisualData(importedCard).card.value !== "—",
    importedCard && api.buildVisualData(importedCard).card.value,
  );

  const textbox = page().visuals.find((v) => v.type === "textbox");
  click(document.querySelector(`.pbc-visual[data-visual="${textbox.id}"]`));
  const textArea = document.getElementById("visual-text");
  ok("textbox editor appears", !!textArea);
  if (textArea) {
    textArea.value = "Contoso FY24-26 review";
    textArea.dispatchEvent(new Event("input", { bubbles: true }));
    ok("textbox updates model", textbox.text === "Contoso FY24-26 review", textbox.text);
    ok(
      "textbox updates canvas",
      document.querySelector(`.pbc-visual[data-visual="${textbox.id}"] .pbc-textbox`).textContent ===
        "Contoso FY24-26 review",
    );
  }

  const matrixPage = api.state.report.pages[1];
  api.state.report.activePage = matrixPage.id;
  api.render();
  const matrixData = api.buildVisualData(matrixPage.visuals.find((v) => v.type === "matrix"));
  ok("matrix has a total row", matrixData.rows[matrixData.rows.length - 1][0] === "Total");
  ok("matrix has row and column headers", matrixData.headers.length > 2 && matrixData.rows.length > 2, {
    headers: matrixData.headers.length,
    rows: matrixData.rows.length,
  });

  // ================================================== guest browser storage
  await sleep(1700);
  const autosaveRows = await idbAll("projects");
  const autosave = autosaveRows.find((p) => p.id === "autosave");
  ok("autosave is persisted in IndexedDB", !!autosave, autosaveRows.map((p) => p.id));
  ok(
    "autosave keeps the full model and report",
    !!autosave && autosave.model.tables.length >= 5 && autosave.report.pages.length === 2,
    autosave && { tables: autosave.model.tables.length, pages: autosave.report.pages.length },
  );
  const datasetRows = await idbAll("datasets");
  ok("imported datasets are persisted in IndexedDB", datasetRows.length >= 1, datasetRows.length);
  const prefsRaw = localStorage.getItem("pbc.prefs.v1");
  ok("preferences use localStorage, not the dataset store", !!prefsRaw && !prefsRaw.includes("tables"), prefsRaw);
  ok("localStorage stays small", !!prefsRaw && prefsRaw.length < 500, prefsRaw && prefsRaw.length);

  click(document.querySelector('[data-action="open-library"]'));
  await waitFor(() => document.querySelector(".pbc-lib"), "browser library");
  ok("library opens for a guest", !!document.querySelector(".pbc-lib"));
  const autosaveRow = await waitFor(
    () => document.querySelector(".pbc-lib-row-autosave"),
    "autosave row in library",
  );
  ok("library lists the autosave", !!autosaveRow);

  const libName = `Browser smoke ${Date.now()}`;
  const saveForm = document.querySelector('form[data-lib-form="save-project"]');
  saveForm.querySelector('[name="name"]').value = libName;
  saveForm.requestSubmit();
  const savedRow = await waitFor(
    () => [...document.querySelectorAll(".pbc-lib-row")].find((r) => r.textContent.includes(libName)),
    "saved project row",
  );
  ok("project saves to the browser without an account", !!savedRow);

  click(document.querySelector('[data-lib-action="tab"][data-tab="datasets"]'));
  await waitFor(() => document.querySelector(".pbc-lib-tab.active")?.textContent.includes("Datasets"), "dataset tab");
  ok(
    "dataset tab lists the imported CSV",
    [...document.querySelectorAll(".pbc-lib-row")].some((r) => /CSV/i.test(r.textContent) && /cities/i.test(r.textContent)),
    [...document.querySelectorAll(".pbc-lib-row")].map((r) => r.textContent.trim()),
  );
  click(document.querySelector('[data-lib-action="close"]'));

  click(document.querySelector('[data-action="open-library"]'));
  await waitFor(() => document.querySelector(".pbc-lib-row-autosave"), "project list refresh");
  const reopenRow = await waitFor(
    () => [...document.querySelectorAll(".pbc-lib-row")].find((r) => r.textContent.includes(libName)),
    "saved row after reopen",
  );
  click(reopenRow.querySelector('[data-lib-action="open"]'));
  await waitFor(() => !document.querySelector(".pbc-lib"), "library to close after open");
  ok("saved project reopens from the browser", api.state.report.name === libName, api.state.report.name);
  ok("reopened project keeps its tables", api.state.model.tables.length >= 5, api.state.model.tables.length);

  click(document.querySelector('[data-action="open-library"]'));
  await waitFor(() => document.querySelector(".pbc-lib-row-autosave"), "library after reopen");
  const deleteRow = await waitFor(
    () => [...document.querySelectorAll(".pbc-lib-row")].find((r) => r.textContent.includes(libName)),
    "saved row before delete",
  );
  click(deleteRow.querySelector('[data-lib-action="delete-project"]'));
  await waitFor(
    () => ![...document.querySelectorAll(".pbc-lib-row")].some((r) => r.textContent.includes(libName)),
    "saved project deletion",
  );
  ok("saved project can be deleted", !([...document.querySelectorAll(".pbc-lib-row")].some((r) => r.textContent.includes(libName))));
  click(document.querySelector('[data-lib-action="close"]'));

  // ======================================================= AI disclosure flow
  click(document.querySelector('[data-action="open-ai"]'));
  await waitFor(() => document.querySelector(".pbc-ai-sent"), "AI disclosure");
  ok("AI panel requires a disclosure before use", !!document.querySelector(".pbc-ai-sent"));
  ok(
    "AI disclosure says raw rows are off by default",
    /no raw rows/i.test(document.querySelector(".pbc-ai-sent")?.textContent ?? ""),
    document.querySelector(".pbc-ai-sent")?.textContent,
  );
  ok(
    "AI send button is disabled before consent",
    document.querySelector('form[data-ai-form="analyze"] button[type="submit"]')?.disabled === true,
  );
  click(document.querySelector('[data-ai-action="preview"]'));
  const payload = await waitFor(() => document.querySelector(".pbc-ai-payload"), "exact payload preview");
  ok("payload preview excludes raw rows", !payload.textContent.includes("sampleRows"));
  ok("payload preview includes table summaries", payload.textContent.includes('"rowCount"'));

  const consent = document.querySelector("[data-ai-consent]");
  consent.checked = true;
  consent.dispatchEvent(new Event("change", { bubbles: true }));
  const question = document.querySelector('form[data-ai-form="analyze"] [name="question"]');
  question.value = "What should I look at first?";
  question.dispatchEvent(new Event("input", { bubbles: true }));
  const aiForm = document.querySelector('form[data-ai-form="analyze"]');
  ok("AI send button enables after consent", aiForm.querySelector('button[type="submit"]').disabled === false);
  aiForm.requestSubmit();
  const aiResult = await waitFor(() => document.querySelector(".pbc-ai-result"), "AI result", 15000);
  ok("AI analysis renders a response", /smoke analysis/i.test(aiResult.textContent), aiResult.textContent);
  ok(
    "AI result labels the model and quota",
    /test-model/i.test(document.querySelector(".pbc-ai-right .pbc-hint")?.textContent ?? ""),
    document.querySelector(".pbc-ai-right .pbc-hint")?.textContent,
  );
  click(document.querySelector('[data-ai-action="close"]'));
  ok("AI panel closes", !document.querySelector(".pbc-ai"));

  reset();
  ok("reset restores the demo", api.state.model.tables.length === 4 && api.state.report.pages.length === 2, {
    tables: api.state.model.tables.length,
    pages: api.state.report.pages.length,
  });

  const failed = results.filter((r) => !r.pass);
  const summary = {
    passed: results.length - failed.length,
    total: results.length,
    failed,
  };
  console.table(results.map((r) => ({ check: r.name, pass: r.pass })));
  if (failed.length) console.error("PowerBICraft smoke failures", failed);
  else console.info(`PowerBICraft smoke: ${summary.passed}/${summary.total} passed`);
  return summary;
};
