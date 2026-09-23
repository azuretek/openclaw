import { expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../auth-profiles.js";
import { prepareAgentRuntimeAuthPlan } from "./prepare-auth.test-support.js";

// This suite owns the Platform-route requirement for a first-party id that has no
// static route contract, so provider hooks stay out of the planner fixture.
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

function authStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: 1, profiles };
}

it("requires a Platform-compatible source for a contract-less first-party id", () => {
  expect(() =>
    prepareAgentRuntimeAuthPlan({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      env: {},
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileStore: authStore({}),
    }),
  ).toThrow("No route-compatible authentication source is configured for openai.");
});
