#!/usr/bin/env node
// Captures the sidebar footer action strip (Home, Settings, inbox) from the
// source Control UI so the three icons can be reviewed together at desktop and
// at the narrowest sidebar width. Run with:
//   node --import ./scripts/tsx.mjs scripts/capture-sidebar-footer-proof.mts
import path from "node:path";
import { chromium, type Page } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = createControlUiE2eArtifactDir(
  "sidebar-footer-proof",
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() ??
    ".artifacts/control-ui-e2e/sidebar-footer-proof",
);
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const FOOTER_ACTIONS = [
  ".sidebar-footer-bar__home",
  ".sidebar-footer-bar__settings",
  ".sidebar-issues-button",
] as const;

const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const captured: { name: string; path: string; sidebarWidth: number }[] = [];

/** Desktop first, then the narrowest viewport that still lays the sidebar out. */
const VIEWPORTS = [
  { name: "01-footer-desktop", width: 1280, height: 900 },
  { name: "02-footer-narrow-viewport", width: 1000, height: 900 },
] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function readFooterActionOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".sidebar-footer-actions button")).map(
      (button) => button.className,
    ),
  );
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  const target = path.join(outputDir, `${name}.png`);
  await page.locator(".sidebar-shell__footer").screenshot({ animations: "disabled", path: target });
  const sidebarWidth = await page
    .locator(".sidebar-shell")
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
  captured.push({ name, path: target, sidebarWidth });
}

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await installMockGateway(page, {
      // The Home affordance only renders for a Gateway advertising the chat
      // methods the home panel calls.
      featureMethods: ["chat.history", "chat.send", "chat.startup"],
      sessionKey: "agent:main:main",
    });
    await page.goto(`${server.baseUrl}chat`);
    await page.locator("openclaw-app-sidebar").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    // Below this width the shell collapses the nav into an off-canvas touch
    // drawer, which this harness cannot swipe open.
    for (const selector of FOOTER_ACTIONS) {
      await page.locator(selector).waitFor({ state: "visible" });
    }
    const actions = await readFooterActionOrder(page);
    if (actions.length !== FOOTER_ACTIONS.length) {
      throw new Error(
        `The footer strip is missing one of Home, Settings or the inbox: ${actions.join(", ")}`,
      );
    }
    if (
      (await page
        .locator(".sidebar-shell")
        .evaluate((element) => element.getBoundingClientRect().left)) < 0
    ) {
      throw new Error("The sidebar is off-canvas at this viewport, so the footer is not visible");
    }
    await capture(page, viewport.name);
    await page.locator(".sidebar-shell").screenshot({
      animations: "disabled",
      path: path.join(outputDir, `${viewport.name}-sidebar.png`),
    });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(JSON.stringify({ captured, outputDir }, null, 2));
