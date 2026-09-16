// Control UI sidebar footer tests cover cross-route layout parity.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  setupSidebarTest,
} from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;

let browser: Browser;
let page: Page;

function readUiCss(): string {
  return ["base.css", "components.css", "layout.css"]
    .map((file) => readStyleSheet(`ui/src/styles/${file}`))
    .join("\n");
}

beforeAll(async () => {
  if (!chromiumAvailable) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 400 } });
});

afterAll(async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
});

describeBrowserLayout("sidebar footer layout", () => {
  setupSidebarTest();
  beforeAll(async () => {
    if (!chromiumAvailable) {
      return;
    }
    await page.setContent(`
      <!doctype html>
      <html data-theme-mode="light">
        <head>
          <style>${readUiCss()}</style>
          <style>
            .footer-layout-fixture {
              display: flex;
              width: 576px;
              height: 220px;
            }
            .footer-layout-fixture > * {
              width: 288px;
              min-height: 0;
            }
          </style>
        </head>
        <body>
          <main class="shell footer-layout-fixture">
            <section class="sidebar-shell">
              <div class="sidebar-shell__content"></div>
              <div class="sidebar-shell__footer">
                <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
                  <button class="sidebar-identity-card" type="button">
                    <span class="viewer-avatar viewer-avatar--footer is-fallback">
                      <span class="viewer-avatar__fallback">M</span>
                    </span>
                    <span class="sidebar-identity-card__text">
                      <span class="sidebar-identity-card__name">Mason</span>
                    </span>
                  </button>
                  <span class="sidebar-footer-actions">
                    <button class="sidebar-issues-button" type="button">
                      <span class="sidebar-issues-button__icon"></span>
                    </button>
                  </span>
                </div>
              </div>
            </section>
            <aside class="settings-sidebar">
              <div class="sidebar-shell__content"></div>
              <footer class="settings-sidebar__footer">
                <openclaw-settings-save-indicator></openclaw-settings-save-indicator>
                <span class="sidebar-footer-build">2026.8.1 · git@5328856</span>
              </footer>
            </aside>
          </main>
        </body>
      </html>
    `);
  });

  it("lands both sidebar footers on one divider line", async () => {
    // Height parity alone stayed true while the main divider sat a shell
    // gutter higher, so the takeover jumped: measure from the sidebar edge.
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const shell = box(".sidebar-shell");
      const shellFooter = box(".sidebar-shell__footer");
      const settings = box(".settings-sidebar");
      const settingsFooter = box(".settings-sidebar__footer");
      if (!(shell && shellFooter && settings && settingsFooter)) {
        return null;
      }
      return {
        mainHeight: shellFooter.height,
        settingsHeight: settingsFooter.height,
        mainDividerFromBottom: shell.bottom - shellFooter.top,
        settingsDividerFromBottom: settings.bottom - settingsFooter.top,
        mainOverhang: shell.bottom - shellFooter.bottom,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry?.settingsHeight).toBeCloseTo(geometry?.mainHeight ?? 0, 2);
    // The strip is chrome: it bleeds to the sidebar edge instead of sitting on
    // the shell's bottom content gutter.
    expect(geometry?.mainOverhang).toBeCloseTo(0, 2);
    expect(geometry?.settingsDividerFromBottom).toBeCloseTo(
      geometry?.mainDividerFromBottom ?? 0,
      2,
    );
  });

  it("centers the account row between the divider and the sidebar edge", async () => {
    const centering = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const shell = box(".sidebar-shell");
      const footer = box(".sidebar-shell__footer");
      const card = box(".sidebar-identity-card");
      const action = box(".sidebar-issues-button");
      if (!(shell && footer && card && action)) {
        return null;
      }
      const dividerWidth = Number.parseFloat(
        getComputedStyle(document.querySelector(".sidebar-shell__footer") as Element)
          .borderBlockStartWidth,
      );
      return {
        above: card.top - (footer.top + dividerWidth),
        below: shell.bottom - card.bottom,
        cardCenterY: (card.top + card.bottom) / 2,
        actionCenterY: (action.top + action.bottom) / 2,
        leadingInset: card.left - shell.left,
        trailingInset: shell.right - action.right,
      };
    });

    expect(centering).not.toBeNull();
    // Measured from the divider's inner edge, the band splits evenly.
    expect(centering?.above).toBeCloseTo(centering?.below ?? 0, 2);
    expect(centering?.actionCenterY).toBeCloseTo(centering?.cardCenterY ?? 0, 2);
    expect(centering?.trailingInset).toBeCloseTo(centering?.leadingInset ?? 0, 2);
  });

  it("fits the rendered native two-line identity inside the 53px footer", async () => {
    setNativeGatewayTestState("local");
    try {
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
      );
      const card = sidebar.querySelector<HTMLElement>(".sidebar-identity-card")!;
      const avatar = card.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-viewer-avatar",
      )!;
      await avatar.updateComplete;
      await page.locator(".sidebar-identity-card").evaluate((element, markup) => {
        element.outerHTML = markup;
      }, card.outerHTML);
      const geometry = await page.evaluate(() => {
        const box = (selector: string) => {
          const { top, bottom, right, height } = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { top, bottom, right, height };
        };
        return {
          footer: box(".sidebar-shell__footer"),
          card: box(".sidebar-identity-card"),
          name: box(".sidebar-identity-card__name"),
          gateway: box(".sidebar-identity-card__gateway"),
          avatar: box(".sidebar-identity-card .viewer-avatar--footer"),
        };
      });
      expect(geometry.footer.height).toBe(53);
      expect(geometry.name.height).toBe(18);
      expect(geometry.gateway.height).toBe(14);
      expect(geometry.gateway.top).toBeGreaterThanOrEqual(geometry.name.bottom);
      expect(geometry.avatar.height).toBe(28);
      expect(geometry.card.top).toBeGreaterThan(geometry.footer.top);
      expect(geometry.card.bottom).toBeLessThan(geometry.footer.bottom);
      for (const content of [geometry.name, geometry.gateway, geometry.avatar]) {
        expect(content.top).toBeGreaterThanOrEqual(geometry.card.top);
        expect(content.bottom).toBeLessThanOrEqual(geometry.card.bottom);
        expect(content.right).toBeLessThanOrEqual(geometry.card.right);
      }
    } finally {
      clearNativeGatewayTestState();
    }
  });
});

// The footer strip is shared chrome on every route, so a third action has to fit
// the narrowest sidebar the resizer allows without pushing the identity card
// underneath it. Measured on the real rendered footer at three widths.
const SIDEBAR_MIN_WIDTH = 240;
const FOOTER_ACTION_WIDTHS = [SIDEBAR_MIN_WIDTH, 288, 390] as const;
/** WCAG 2.5.8 (Target Size Minimum) floor for a pointer target. */
const MIN_TOUCH_TARGET = 24;
const FOOTER_EDGE_INSET = 8;

/** Where the three footer actions should land once measured left to right. */
const FOOTER_ACTION_ORDER = [
  "sidebar-brand__icon sidebar-footer-bar__home",
  "sidebar-brand__icon sidebar-footer-bar__settings",
  "sidebar-issues-button",
] as const;

describeBrowserLayout("sidebar footer action strip", () => {
  setupSidebarTest();
  let stripPage: Page | null = null;
  let footerMarkup: string | null = null;

  async function openStripPage(): Promise<Page> {
    stripPage ??= await browser.newPage({ viewport: { width: 800, height: 400 } });
    return stripPage;
  }

  async function readFooterMarkup(): Promise<string> {
    if (footerMarkup !== null) {
      return footerMarkup;
    }
    const harness = createGatewayHarness({} as GatewayBrowserClient);
    // Home renders only for a Gateway advertising what the home panel calls.
    harness.publish({
      hello: gatewayHelloForMethods([
        ...SESSION_MUTATION_TEST_METHODS,
        "chat.history",
        "chat.send",
      ]),
    });
    const { sidebar } = await mountSidebar(
      harness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    const markup = sidebar.querySelector<HTMLElement>(".sidebar-footer-bar")?.outerHTML ?? "";
    expect(markup).toContain("sidebar-footer-bar__settings");
    // The shared sidebar harness keeps the inbox widget inert, so supply its
    // inner button here; production renders the same light-DOM shape.
    footerMarkup = markup.replace(
      "</openclaw-sidebar-attention>",
      '<button class="sidebar-issues-button" type="button"></button></openclaw-sidebar-attention>',
    );
    return footerMarkup;
  }

  afterAll(async () => {
    await stripPage?.close().catch(() => {});
  });

  it.each(FOOTER_ACTION_WIDTHS)(
    "keeps the three footer actions clear of the identity card at %ipx",
    async (width) => {
      const measure = await openStripPage();
      await measure.setContent(`
        <!doctype html>
        <html data-theme-mode="light">
          <head>
            <style>${readUiCss()}</style>
            <style>
              .footer-strip-fixture {
                display: flex;
                width: ${width}px;
                height: 220px;
              }
              .footer-strip-fixture > * {
                width: 100%;
                min-height: 0;
              }
            </style>
          </head>
          <body>
            <main class="shell footer-strip-fixture">
              <section class="sidebar-shell">
                <div class="sidebar-shell__content"></div>
                <div class="sidebar-shell__footer">${await readFooterMarkup()}</div>
              </section>
            </main>
          </body>
        </html>
      `);

      const geometry = await measure.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) {
            return null;
          }
          const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
          return { top, bottom, left, right, width, height };
        };
        const bar = document.querySelector<HTMLElement>(".sidebar-footer-bar");
        return {
          bar: box(".sidebar-footer-bar"),
          card: box(".sidebar-identity-card"),
          actions: box(".sidebar-footer-actions"),
          buttons: Array.from(
            document.querySelectorAll<HTMLElement>(".sidebar-footer-actions button"),
          ).map((button) => {
            const { top, bottom, left, width, height } = button.getBoundingClientRect();
            return { top, bottom, left, width, height, className: button.className };
          }),
          overflowX: bar ? bar.scrollWidth - bar.clientWidth : Number.NaN,
        };
      });

      expect(geometry.bar).not.toBeNull();
      expect(geometry.card).not.toBeNull();
      expect(geometry.actions).not.toBeNull();
      const ordered = [...geometry.buttons].sort((a, b) => a.left - b.left);
      expect(ordered.map((button) => button.className)).toEqual([...FOOTER_ACTION_ORDER]);
      const home = ordered[0]!;
      const settings = ordered[1]!;
      const inbox = ordered[2]!;
      // Settings carries the Home affordance's own box, not a narrower one.
      expect(settings.width).toBe(home.width);
      expect(settings.height).toBe(home.height);
      for (const button of ordered) {
        // Touch targets clear the 24px WCAG 2.5.8 floor at every width.
        expect(button.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
        expect(button.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
        expect(button.top).toBeGreaterThanOrEqual(geometry.bar!.top);
        expect(button.bottom).toBeLessThanOrEqual(geometry.bar!.bottom);
      }
      // The strip stays on the sidebar edge, and the card stops before it.
      expect(geometry.bar!.right - geometry.actions!.right).toBeCloseTo(FOOTER_EDGE_INSET, 2);
      expect(geometry.card!.right).toBeLessThanOrEqual(geometry.actions!.left);
      expect(settings.left).toBeGreaterThanOrEqual(home.left);
      expect(inbox.left).toBeGreaterThanOrEqual(settings.left);
      expect(geometry.overflowX).toBeLessThanOrEqual(0);
    },
  );
});
