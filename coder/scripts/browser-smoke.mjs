import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createDemoWorkbench } from "../dist/workbenchDemo.js";
const artifacts =
  process.env.VIMS_BROWSER_ARTIFACTS ??
  (await fs.mkdtemp(path.join(os.tmpdir(), "vims-browser-evidence-")));
await fs.mkdir(artifacts, { recursive: true });
const demo = await createDemoWorkbench();
let browser;
let page;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {}),
    chromiumSandbox: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    colorScheme: "dark",
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function waitFor(predicate, message) {
    const until = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error(message);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  let firstRunId, threadId;
  await page.goto(demo.url + "/#" + demo.token);
  await page.locator("#new-thread").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  await page.locator("#new-thread").click();
  await page.locator("#new-title").fill("Native release-note review");
  await page
    .getByRole("button", { name: "Create thread", exact: true })
    .click();
  await page
    .locator("#thread-title")
    .filter({ hasText: "Native release-note review" })
    .waitFor();
  threadId = demo.core.store.threads()[0].id;
  // The server accepts the first queue command, but its acknowledgement is lost.
  let dropped = false;
  const submitted = [];
  await page.route("**/api/command", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "run.queue") {
      submitted.push(body);
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
    }
    await route.continue();
  });
  await page
    .locator("#prompt")
    .fill(
      "Write a concise release note documenting native task approvals and isolated checkpoint review.",
    );
  await page.locator("#queue").click();
  await page.locator("#uncertain").waitFor({ state: "visible" });
  assert.equal(demo.core.store.runs(threadId).length, 1);
  await page.locator("#retry").click();
  await page.locator("#uncertain").waitFor({ state: "hidden" });
  await page.locator(".run-card").waitFor();
  assert.equal(demo.core.store.runs(threadId).length, 1);
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0], submitted[1]);
  firstRunId = demo.core.store.runs(threadId)[0].id;
  const card = page.locator(`[data-run-id="${firstRunId}"]`);
  await card.getByRole("button", { name: "Approve task", exact: true }).click();
  await waitFor(
    () => demo.core.store.run(firstRunId).status === "queued",
    "approval did not persist",
  );
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .locator("#prompt")
    .fill(
      "Write a concise release note about native VIMS approvals, portable context, and safe checkpoint branches.",
    );
  await page.locator("#queue").click();
  await waitFor(
    () => demo.core.store.run(firstRunId).revision === 2,
    "edit did not persist",
  );
  assert.equal(demo.core.store.run(firstRunId).approved, false);
  await card.getByRole("button", { name: "Approve task", exact: true }).click();
  await page.locator("#execute").click();
  await page
    .getByRole("heading", { name: "Choose the note format", exact: true })
    .waitFor();
  await page.getByLabel("Compact note", { exact: true }).check();
  await page.getByRole("button", { name: "Send answers", exact: true }).click();
  await page
    .getByRole("heading", { name: "Approve this file write", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await waitFor(
    () => demo.core.store.run(firstRunId).status === "completed",
    "native fixture failed to complete",
  );
  await card
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page.locator("#review").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#patch").innerText(),
    /native VIMS approvals/,
  );
  assert.equal(
    await fs.readFile(path.join(demo.repository, "README.md"), "utf8"),
    "# Native VIMS workbench fixture\n\nThe primary checkout stays unchanged.\n",
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: path.join(artifacts, "workbench-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "mobile page overflows",
  );
  await page.screenshot({
    path: path.join(artifacts, "workbench-mobile.png"),
    fullPage: true,
  });
  await card
    .getByRole("button", { name: "Branch from after", exact: true })
    .click();
  await waitFor(
    () => demo.core.store.threads().length === 2,
    "checkpoint branch was not created",
  );
  const child = demo.core.store.threads().find((t) => t.id !== threadId);
  assert.equal(child.baseRef, demo.core.store.run(firstRunId).after);
  assert.equal(child.forkedFrom.threadId, threadId);
  // Render adversarial repository/agent-style text as inert text, never markup.
  await page
    .locator("#prompt")
    .fill('<img src=x onerror="globalThis.__vimsInjected=true">');
  await page.locator("#queue").click();
  await waitFor(
    () => demo.core.store.runs(child.id).length === 1,
    "child queue did not persist",
  );
  await page.locator(".run-prompt").filter({ hasText: "<img" }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.__vimsInjected), undefined);
  assert.equal(await page.locator(".run-prompt img").count(), 0);
  assert.deepEqual(errors, []);
  const cookies = await context.cookies();
  assert.deepEqual(cookies, []);
  const report = {
    browser: "Chromium",
    viewportChecks: ["1440x1100", "390x844"],
    checks: [
      "token fragment removed",
      "no browser credential storage",
      "lost-ack retry uses identical command",
      "single durable submission",
      "edit invalidates approval",
      "runtime question and allow-once gate",
      "real Git diff",
      "primary checkout preserved",
      "checkpoint branch",
      "inert hostile markup",
      "no page JavaScript errors",
    ],
    nativeRuns: demo.core.store.runs(threadId).length,
    errors,
  };
  await fs.writeFile(
    path.join(artifacts, "browser-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  console.log("Browser evidence directory:", artifacts);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true })
      .catch(() => {});
  throw new Error(
    String(error).replaceAll(demo.token, "[redacted local token]"),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await demo.close();
  }
}
