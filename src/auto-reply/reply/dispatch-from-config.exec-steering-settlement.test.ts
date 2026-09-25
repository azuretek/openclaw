// Exec-steering settlement tests: a steered completion is acknowledged only once
// the reply that folded it in is delivered, and released otherwise.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { isExecSteeringReplySettled } from "./dispatch-from-config.finalize.js";
import {
  createHookCtx,
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: typeof import("./reply-run-registry.test-support.js").testing.resetReplyRunRegistry;

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({
    testing: { resetReplyRunRegistry },
  } = await import("./reply-run-registry.test-support.js"));
});

beforeEach(() => {
  clearAgentHarnesses();
  resetReplyRunRegistry();
  resetInboundDedupe();
  setDiscordTestRegistry();
  resetPluginTtsAndThreadMocks();
  hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionStoreEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
  sessionStoreMocks.readSessionEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveSessionStorePathCore
    .mockReset()
    .mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
  sessionStoreMocks.updateSessionEntry.mockClear();
});

afterEach(() => {
  resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

describe("exec-steering delivery settlement", () => {
  it("acknowledges a steered completion after its final reply is delivered", async () => {
    const order: string[] = [];
    const settle = vi.fn((delivered: boolean) => {
      order.push(`settle:${delivered}`);
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        order.push(`deliver:${payload.text}`);
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    expect(order).toEqual(["deliver:The build finished.", "settle:true"]);
  });

  it("releases a steered completion when the final send fails", async () => {
    const settle = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
      },
    });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return { text: "The build finished." };
          },
        }),
    });

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([true, false])(
    "settles a routed reply from its delivered receipt (%s)",
    async (delivered) => {
      const settle = vi.fn();
      const deliver = vi.fn();
      const dispatcher = createReplyDispatcher({ deliver });
      const ctx = createHookCtx();
      Object.assign(ctx, { OriginatingChannel: "discord", OriginatingTo: "user:1" });
      mocks.routeReply.mockResolvedValue({ ok: true, delivered, messageId: "routed" });

      await withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx,
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingExecSteering?.({ settle });
              return { text: "The build finished." };
            },
          }),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledExactlyOnceWith(delivered);
    },
  );

  it("releases a steered completion when session-writer delivery is revoked", async () => {
    const reply = setReplyPayloadMetadata(
      { text: "The build finished." },
      {
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedLifecycleRevision: "revision-before-replacement",
          expectedSessionId: "session-1",
          expectedWriterRunId: "run-before-replacement",
          sessionKey: "agent:test:session",
          storePath: "/tmp/mock-sessions.json",
        },
      },
    );
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      lifecycleRevision: "revision-after-replacement",
      activeWriterRunId: "run-after-replacement",
    };
    const settle = vi.fn();
    const deliver = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle });
            return reply;
          },
        }),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("releases a steered completion when the resolver fails before finalization", async () => {
    const settle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    const failure = new Error("run failed after dispatch");

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: () =>
          dispatchReplyFromConfig({
            ctx: createHookCtx(),
            cfg: emptyConfig,
            dispatcher,
            replyResolver: async (_ctx, opts) => {
              opts?.onPendingExecSteering?.({ settle });
              throw failure;
            },
          }),
      }),
    ).rejects.toThrow(failure);

    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("settles every receipt a multi-attempt turn handed over", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });

    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: createHookCtx(),
          cfg: emptyConfig,
          dispatcher,
          replyResolver: async (_ctx, opts) => {
            opts?.onPendingExecSteering?.({ settle: first });
            opts?.onPendingExecSteering?.({ settle: second });
            return { text: "The build finished." };
          },
        }),
    });

    expect(first).toHaveBeenCalledExactlyOnceWith(true);
    expect(second).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("isExecSteeringReplySettled", () => {
  it.each([
    { name: "delivered final", replies: [{ text: "done" }], terminal: "delivered", expected: true },
    {
      name: "undelivered final",
      replies: [{ text: "done" }],
      terminal: "missing",
      expected: false,
    },
    { name: "unsettled final", replies: [{ text: "done" }], terminal: "pending", expected: false },
    { name: "deliberate silent reply", replies: [], terminal: "missing", expected: true },
    {
      name: "whitespace-only reply",
      replies: [{ text: "  " }],
      terminal: "missing",
      expected: true,
    },
    {
      name: "finalization never reached",
      replies: undefined,
      terminal: "delivered",
      expected: false,
    },
  ] as const)("$name -> $expected", ({ replies, terminal, expected }) => {
    expect(
      isExecSteeringReplySettled({
        replies: replies ? [...replies] : undefined,
        terminalDelivery: terminal,
        messageToolOnly: false,
      }),
    ).toBe(expected);
  });

  it("treats message-tool-only delivery as consumed by the model's own send", () => {
    expect(
      isExecSteeringReplySettled({
        replies: [{ text: "done" }],
        terminalDelivery: "missing",
        messageToolOnly: true,
      }),
    ).toBe(true);
  });
});
