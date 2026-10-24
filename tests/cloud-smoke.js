/**
 * PowerBICraft service-tier browser smoke suite.
 *
 * Covers the flows that only exist once the local service is running:
 * accounts, workspaces, publishing, share links, the read-only viewer,
 * deployment stages, embed tokens + CSP, scheduled-refresh UI and email
 * subscriptions.
 *
 * Usage: open the app (npm run dev or npm run serve with the API up), then
 *
 *     const s = document.createElement("script");
 *     s.src = "/tests/cloud-smoke.js";
 *     document.head.append(s);
 *     await window.runPowerBICraftCloudSmoke();
 *
 * The suite signs up a throwaway account, publishes the sample report to that
 * account's personal workspace and deletes everything it created.
 */
window.runPowerBICraftCloudSmoke = async function runPowerBICraftCloudSmoke() {
  const cloud = window.pbcCloud;
  const app = window.powerbicraft;
  if (!cloud || !app) throw new Error("PowerBICraft is not loaded on this page");

  const results = [];
  const ok = (name, cond, extra) =>
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (sel, root = document) => q(sel, root)?.textContent?.trim() ?? "";
  const click = (el) => {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  };
  const submit = (form) => {
    if (!form) return false;
    form.requestSubmit();
    return true;
  };
  const waitFor = async (fn, label, ms = 10000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  // The dialog ignores input while a request is in flight (the overlay covers
  // it for real users), so scripted steps wait for it to go idle first.
  const idle = () => waitFor(() => !cloud.state.busy, "the previous action to finish");
  const frameLoad = (frame) =>
    new Promise((resolve) => {
      if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.querySelector(".pbc-viewer"))
        resolve();
      else frame.addEventListener("load", () => resolve(), { once: true });
    });

  const stamp = Date.now();
  const email = `smoke-${stamp}@powerbicraft.test`;
  const name = "Cloud Smoke";
  const uid = `smoke-uid-${stamp}`;
  const workspaceName = `Smoke ${stamp}`;
  const dashboardName = `Smoke dashboard ${stamp}`;
  const originalConfirm = window.confirm;
  window.confirm = () => true;

  // The smoke suite runs against tests/smoke-server.ts, which accepts these
  // test-only identities instead of Firebase ID tokens. Nothing in production
  // reads __pbcTestToken (it is behind import.meta.env.DEV).
  const b64url = (value) =>
    btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const testToken = `test:${b64url(JSON.stringify({ uid, email, name }))}`;

  // Start from a clean guest session and the sample report.
  window.__pbcTestToken = testToken;
  cloud.state.open = false;
  cloud.state.me = null;
  app.state.report = app.emptyReport();
  click(document.querySelector('[data-action="reset-demo"]'));
  await sleep(300);

  try {
    // ------------------------------------------- guest-first + test identity
    click(document.querySelector('[data-action="open-cloud"]'));
    await waitFor(() => q(".pbc-cloud-side"), "signed-in shell");
    await idle();
    ok("test identity signs in without Firebase", cloud.state.me?.user?.email === email);
    ok(
      "sign-in creates a personal workspace",
      cloud.state.workspaces.some((w) => w.kind === "personal" && w.role === "owner"),
      cloud.state.workspaces,
    );
    ok("user chip shows the account", text(".pbc-cloud-who").includes(email));

    // --------------------------------------------------------- workspace
    const wsForm = q('form[data-cloud-form="workspace"]');
    wsForm.querySelector('[name="name"]').value = workspaceName;
    submit(wsForm);
    await waitFor(() => cloud.state.workspaces.some((w) => w.name === workspaceName), "new workspace");
    await waitFor(() => cloud.state.ws?.workspace?.name === workspaceName, "new workspace to load");
    await idle();
    ok("team workspace is created", cloud.state.ws?.workspace?.name === workspaceName);
    ok("workspace list is updated", cloud.state.workspaces.length === 2, cloud.state.workspaces.length);

    // ----------------------------------------------------------- publish
    await waitFor(() => q('form[data-cloud-form="publish"]'), "publish form");
    const publishForm = q('form[data-cloud-form="publish"]');
    publishForm.querySelector('[name="name"]').value = dashboardName;
    publishForm.querySelector('[name="note"]').value = "cloud smoke publish";
    submit(publishForm);
    await waitFor(() => q(".pbc-cloud-dash-head h2"), "dashboard panel", 20000);
    await idle();
    ok("publish creates version 1", cloud.state.dash?.versions?.length === 1 && cloud.state.dash.versions[0].seq === 1);
    ok("publish moves the dev stage", cloud.state.dash?.stageDetails?.dev?.seq === 1);
    ok("dashboard appears in the sidebar", !!qa('[data-cloud="select-dash"]').find((b) => b.textContent.includes(dashboardName)));
    ok("publish keeps real report content", cloud.state.dash?.report?.pages?.length === 2);

    // -------------------------------------------------------- share link
    click(q('[data-cloud="tab"][data-tab="share"]'));
    await waitFor(() => q('form[data-cloud-form="share"]'), "share form");
    await idle();
    const shareForm = q('form[data-cloud-form="share"]');
    shareForm.querySelector('[name="label"]').value = "smoke link";
    shareForm.querySelector('[name="ttl"]').value = "1440";
    submit(shareForm);
    const shareUrl = await waitFor(() => q(".pbc-cloud-result code")?.textContent, "share url");
    ok("share link is created", /^https?:\/\/.+\/v\/[A-Za-z0-9_-]{20,}$/.test(shareUrl), shareUrl);
    ok("share link is listed as active", cloud.state.shares.filter((s) => !s.revokedAt).length === 1);

    const shareToken = shareUrl.split("/v/")[1];
    const sharePayload = await (await fetch(`/api/public/view/${shareToken}`)).json();
    ok("public view API returns the document", !!sharePayload.model?.tables?.length && !!sharePayload.report?.pages?.length);
    ok("public view API resolves the latest version before promotion", sharePayload.stage === "latest", sharePayload.stage);

    // ------------------------------------------------------------ viewer
    const viewer = document.createElement("iframe");
    viewer.style.cssText = "position:fixed;left:-2400px;top:0;width:1200px;height:760px;border:0";
    viewer.src = `/v/${shareToken}`;
    document.body.append(viewer);
    await frameLoad(viewer);
    const vdoc = viewer.contentDocument;
    await waitFor(() => vdoc.querySelector(".pbc-viewer-visual"), "viewer visuals");
    await sleep(300);
    ok("viewer renders the report name", vdoc.querySelector(".pbc-viewer-name")?.textContent === "Contoso Sales");
    ok("viewer renders every visual on page 1", vdoc.querySelectorAll(".pbc-viewer-visual").length === 11, vdoc.querySelectorAll(".pbc-viewer-visual").length);
    ok("viewer labels the shared stage", vdoc.querySelector(".pbc-viewer-badge")?.textContent === "Shared view");
    ok("viewer offers page tabs", vdoc.querySelectorAll("[data-viewer-page]").length === 2);

    const mark = vdoc.querySelector("[data-cf-val]");
    ok("viewer exposes cross-filter marks", !!mark, mark?.dataset.cfVal);
    if (mark) {
      mark.dispatchEvent(new viewer.contentWindow.MouseEvent("click", { bubbles: true }));
      await sleep(300);
      ok("viewer applies a cross-filter", vdoc.querySelectorAll(".pbc-chip").length === 1, vdoc.querySelector(".pbc-chip")?.textContent);
      click(vdoc.querySelector("[data-viewer-clear-selection]"));
      await sleep(200);
      ok("viewer clears the cross-filter", vdoc.querySelectorAll(".pbc-chip").length === 0);
    }

    const page2 = qa("[data-viewer-page]", vdoc).find((b) => b.textContent.includes("Product Detail"));
    click(page2);
    await sleep(300);
    ok("viewer switches pages", vdoc.querySelector(".pbc-page-item.active")?.textContent === "Product Detail");

    // ----------------------------------------------------------- promote
    click(q('[data-cloud="tab"][data-tab="versions"]'));
    await waitFor(() => q(".pbc-stage-card"), "stage cards");
    await idle();
    click(q('[data-cloud="promote"][data-stage="test"]'));
    await waitFor(() => cloud.state.dash?.stageDetails?.test?.seq === 1, "test promotion");
    await idle();
    ok("promote moves a version to test", cloud.state.dash.stageDetails.test.seq === 1);
    click(q('[data-cloud="promote"][data-stage="prod"]'));
    await waitFor(() => cloud.state.dash?.stageDetails?.prod?.seq === 1, "prod promotion");
    await idle();
    ok("promote moves a version to production", cloud.state.dash.stageDetails.prod.seq === 1);

    const prodPayload = await (await fetch(`/api/public/view/${shareToken}`)).json();
    ok("share links resolve production once promoted", prodPayload.stage === "prod", prodPayload.stage);

    viewer.contentWindow.location.reload();
    await frameLoad(viewer);
    await waitFor(() => viewer.contentDocument.querySelector(".pbc-viewer-visual"), "viewer after promotion");
    await sleep(300);
    ok("viewer now shows the production badge", viewer.contentDocument.querySelector(".pbc-viewer-badge")?.textContent === "Production");

    // ------------------------------------------------------------- embed
    click(q('[data-cloud="tab"][data-tab="embed"]'));
    await waitFor(() => q('form[data-cloud-form="embed"]'), "embed form");
    await idle();
    const embedForm = q('form[data-cloud-form="embed"]');
    embedForm.querySelector('[name="origins"]').value = location.origin;
    embedForm.querySelector('[name="ttl"]').value = "60";
    submit(embedForm);
    const snippet = await waitFor(() => q(".pbc-cloud-result code")?.textContent, "embed snippet");
    const embedUrl = snippet.match(/src="([^"]+)"/)?.[1] ?? "";
    ok("embed token renders an iframe snippet", embedUrl.includes("/e/"), snippet);

    const frameResponse = await fetch(embedUrl);
    const csp = frameResponse.headers.get("content-security-policy") ?? "";
    ok("embed page sends a frame-ancestors CSP", csp.includes(`frame-ancestors 'self' ${location.origin}`), csp);

    const embedFrame = document.createElement("iframe");
    embedFrame.style.cssText = "position:fixed;left:-2400px;top:0;width:1000px;height:600px;border:0";
    embedFrame.src = embedUrl;
    document.body.append(embedFrame);
    await frameLoad(embedFrame);
    const edoc = embedFrame.contentDocument;
    await waitFor(() => edoc.querySelector(".pbc-viewer-visual"), "embedded visuals");
    await sleep(300);
    ok("embed page renders the dashboard", edoc.querySelector(".pbc-viewer-name")?.textContent === "Contoso Sales");
    ok("embed page is labelled as an embed", edoc.querySelector(".pbc-viewer-badge")?.textContent === "Embedded view");

    const embedToken = embedUrl.split("/e/")[1];
    click(q('[data-cloud="revoke-embed"]'));
    await waitFor(() => cloud.state.embeds.every((e) => e.revokedAt), "embed revocation");
    ok("revoking an embed token is reflected in the list", cloud.state.embeds.every((e) => e.revokedAt));
    const revokedEmbed = await fetch(`/api/public/embed/${embedToken}`);
    ok("revoked embed token stops resolving", revokedEmbed.status === 404, revokedEmbed.status);
    embedFrame.remove();

    // ----------------------------------------------------------- refresh
    click(q('[data-cloud="tab"][data-tab="refresh"]'));
    await waitFor(() => q('form[data-cloud-form="source"]'), "source form");
    await idle();
    const sourceForm = q('form[data-cloud-form="source"]');
    sourceForm.querySelector('[name="kind"]').value = "csv";
    sourceForm.querySelector('[name="location"]').value = `missing-${stamp}.csv`;
    sourceForm.querySelector('[name="table"]').value = "SmokeTable";
    submit(sourceForm);
    await waitFor(() => cloud.state.sources.length === 1, "source added");
    await idle();
    ok("data source is registered", cloud.state.sources[0].targetTable === "SmokeTable");

    click(q('[data-cloud="refresh-source"]'));
    await waitFor(() => cloud.state.jobs.length > 0 && cloud.state.jobs[0].status !== "running", "refresh job", 20000);
    ok("a failed refresh is reported, not swallowed", cloud.state.jobs[0].status === "error", cloud.state.jobs[0].status);
    ok("the failure explains itself", /missing|ENOENT|not found/i.test(cloud.state.jobs[0].error ?? ""), cloud.state.jobs[0].error);

    click(q('[data-cloud="delete-source"]'));
    await waitFor(() => cloud.state.sources.length === 0, "source removed");
    ok("data source can be removed", cloud.state.sources.length === 0);

    // ------------------------------------------------------- subscription
    await idle();
    const subForm = q('form[data-cloud-form="subscription"]');
    subForm.querySelector('[name="email"]').value = email;
    subForm.querySelector('[name="every"]').value = "1440";
    submit(subForm);
    await waitFor(() => cloud.state.subscriptions.length === 1, "subscription saved");
    ok("email subscription is stored", cloud.state.subscriptions[0].email === email);

    click(q('form[data-cloud-form="send"] button[type="submit"]'));
    await waitFor(() => cloud.state.outbox.some((m) => m.to_email === email), "outbox delivery", 40000);
    const mail = cloud.state.outbox.find((m) => m.to_email === email);
    ok("send-now delivers a message to the outbox", mail.transport === "outbox" && mail.subject.includes(dashboardName), mail.subject);
    ok("subscription mail carries a preview link", /\/v\/[A-Za-z0-9_-]{20,}/.test(mail.link ?? ""), mail.link);
    ok("the delivery job succeeded", cloud.state.jobs.some((j) => j.type === "subscription" && j.status === "ok"), cloud.state.jobs[0]?.status);

    click(q('[data-cloud="delete-subscription"]'));
    await waitFor(() => cloud.state.subscriptions.length === 0, "subscription deleted");
    await idle();
    ok("email subscription can be deleted", cloud.state.subscriptions.length === 0);

    // ---------------------------------------------------------- teardown
    click(q('[data-cloud="tab"][data-tab="share"]'));
    await waitFor(() => q('[data-cloud="revoke-share"]'), "share list");
    await idle();
    click(q('[data-cloud="revoke-share"]'));
    await waitFor(() => cloud.state.shares.every((s) => s.revokedAt), "share revoked");
    const revokedView = await fetch(`/api/public/view/${shareToken}`);
    ok("revoked share link stops resolving", revokedView.status === 404, revokedView.status);
    viewer.remove();

    await idle();
    click(q('[data-cloud="delete-dash"]'));
    await waitFor(() => !cloud.state.dash, "dashboard deleted");
    await idle();
    ok("owner can delete the dashboard", cloud.state.dash === null && cloud.state.ws?.dashboards.length === 0);

    window.__pbcTestToken = null;
    click(q('[data-cloud="signout"]'));
    await waitFor(() => !cloud.state.me?.user, "signed out");
    ok("sign-out returns to the auth screen", !!q(".pbc-cloud-auth-card"));
    ok("no error banner is left behind", !q(".pbc-cloud-banner.pbc-bad"), text(".pbc-cloud-banner.pbc-bad"));
  } catch (err) {
    results.push({ name: "suite completed without throwing", pass: false, extra: String(err?.stack ?? err) });
    const banner = document.querySelector(".pbc-cloud-banner.pbc-bad")?.textContent;
    if (banner) results.push({ name: "error banner contents", pass: false, extra: banner });
  } finally {
    window.confirm = originalConfirm;
    window.__pbcTestToken = null;
    cloud.close();
    document.querySelectorAll("iframe").forEach((f) => {
      if (/\/v\/|\/e\//.test(f.src) && f.style.left === "-2400px") f.remove();
    });
  }

  const failed = results.filter((r) => !r.pass);
  return {
    suite: "cloud",
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
};
