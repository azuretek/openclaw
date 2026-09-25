import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { prepareAgentRuntimeAuthPlan } from "./prepare-auth.test-support.js";

// This suite owns the Platform-route requirement for a first-party id that has no
// static route contract, so provider hooks stay out of the planner fixture.
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

function authStore(
  profiles: AuthProfileStore["profiles"],
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return { version: 1, profiles, ...(order ? { order } : {}) };
}

function codexNanoFixture(modelId = "gpt-5.4-nano") {
  return {
    provider: "openai",
    modelId,
    env: {},
    harnessId: "codex",
    harnessRuntime: "codex",
  } as const;
}

function subscriptionToken() {
  return {
    type: "token" as const,
    provider: "openai",
    token: "subscription-token",
    expires: Date.now() + 60_000,
  };
}

// #148559: before the fix this plan threw "Configured openai authentication is
// not compatible with the selected model route." for every API key.
it("accepts an API key for a contract-less first-party id on the Platform route", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore(
      { "openai:platform": createApiKeyCredential("openai", "platform-key") },
      { openai: ["openai:platform"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    selectedAuthMode: "api_key",
    modelRoute: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    },
  });
});

function chatGPTOAuth() {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "***",
    refresh: "***",
    expires: Date.now() + 60_000,
  };
}

// Before #148559 the offline ChatGPT catalog listed nano, so an unauthored setup
// whose only credential is a ChatGPT login reached nano on the subscription route.
// The Platform default must not take that route away.
it("keeps an OAuth-only unauthored nano on the ChatGPT route", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore({ "openai:chatgpt": chatGPTOAuth() }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    },
  });
});

// The runtime model for nano carries the manifest catalog's Platform row, so the
// planner sees an observed Platform transport even with nothing authored.
it("keeps an OAuth-only nano on the ChatGPT route when a Platform row is observed", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    modelApi: "openai-responses",
    modelBaseUrl: "https://api.openai.com/v1",
    authProfileStore: authStore({ "openai:chatgpt": chatGPTOAuth() }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    },
  });
});

it("routes an API-key-only unauthored nano to the Platform API", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore({
      "openai:platform": createApiKeyCredential("openai", "platform-key"),
    }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:platform",
    modelRoute: { api: "openai-responses", authRequirement: "api-key" },
  });
});

// Automatic selection prefers the subscription route when both credentials are
// eligible (docs/providers/openai/runtimes), so a mixed setup keeps its billing.
it("keeps the subscription preference for nano when both credentials are available", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    authProfileStore: authStore({
      "openai:chatgpt": chatGPTOAuth(),
      "openai:platform": createApiKeyCredential("openai", "platform-key"),
    }),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    },
  });
});

it("keeps an authored ChatGPT adapter for nano on the subscription route", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture(),
    config: {
      models: { providers: { openai: { api: "openai-chatgpt-responses", models: [] } } },
    } as unknown as OpenClawConfig,
    authProfileStore: authStore(
      { "openai:chatgpt": subscriptionToken() },
      { openai: ["openai:chatgpt"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: { api: "openai-chatgpt-responses", authRequirement: "subscription" },
  });
});

it("keeps the dual-route sibling on the subscription route for a ChatGPT-only store", () => {
  const plan = prepareAgentRuntimeAuthPlan({
    ...codexNanoFixture("gpt-5.4-mini"),
    authProfileStore: authStore(
      { "openai:chatgpt": subscriptionToken() },
      { openai: ["openai:chatgpt"] },
    ),
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authRequirement: "subscription",
    },
  });
});

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
