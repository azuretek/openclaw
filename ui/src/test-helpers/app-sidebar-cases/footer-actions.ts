import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../app-sidebar.ts";
import { gatewayHelloForMethods, SESSION_MUTATION_TEST_METHODS } from "../gateway-methods.ts";
import "../../components/app-sidebar.ts";

// The footer strip carries Settings, which otherwise hides one level down in the
// identity menu's account utility list.
describe("AppSidebar footer actions", () => {
  it("opens Settings from the footer strip", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    const settings = sidebar.querySelector<HTMLButtonElement>(".sidebar-footer-bar__settings");
    expect(settings).not.toBeNull();
    expect(settings?.getAttribute("aria-label")).toBe("Settings");

    settings?.click();
    expect(onNavigate).toHaveBeenCalledWith("appearance");
  });

  it("orders Home, Settings and the inbox so the inbox keeps the trailing edge", async () => {
    const harness = createGatewayHarness({} as GatewayBrowserClient);
    // The Home affordance only renders for a Gateway that advertises the chat
    // methods the home panel needs.
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

    const actions = sidebar.querySelector(".sidebar-footer-actions");
    const strip = Array.from(actions?.children ?? []).map((child) => {
      if (child.tagName.toLowerCase() !== "openclaw-tooltip") {
        return child.tagName.toLowerCase();
      }
      return child.firstElementChild?.className ?? "";
    });
    expect(strip).toEqual([
      "sidebar-brand__icon sidebar-footer-bar__home",
      "sidebar-brand__icon sidebar-footer-bar__settings",
      "openclaw-sidebar-attention",
    ]);
  });
});
