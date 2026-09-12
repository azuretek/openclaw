/**
 * Validation: can the carrier and the `process` tool resolve DIFFERENT scope keys
 * for the same attempt, so that a live session is visible to one and not the other?
 *
 * Carrier (runtime-facts-prompt.ts) resolves:
 *   resolveProcessToolScopeKey({
 *     sessionKey: attempt.sessionKey,
 *     sessionId: attempt.sessionId,
 *     agentId: input.sessionAgentId,
 *   })
 *
 * Tools (attempt-tool-prepare.ts -> agent-tools.ts) resolve:
 *   resolveProcessToolScopeKey({
 *     scopeKey: options?.exec?.scopeKey,          // caller override, normally absent
 *     sessionKey: options?.runSessionKey ?? options?.sessionKey,
 *     sessionId: options?.sessionId,
 *     agentId: executionAgentId,
 *   })
 * where buildConversationContext() sets
 *   runSessionKey: attempt.sessionKey?.trim() || attempt.sessionId
 *   sessionId:     attempt.sessionId
 *
 * This enumerates attempt field states and checks the two resolutions agree.
 */
import { describe, expect, it } from "vitest";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { addSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";

type AttemptFields = {
  label: string;
  sessionKey?: string;
  sessionId?: string;
  sandboxSessionKey?: string;
  explicitExecScopeKey?: string;
  sessionAgentId?: string;
  executionAgentId?: string;
};

const cases: AttemptFields[] = [
  {
    label: "dashboard session, all fields present",
    sessionKey: "agent:main:dashboard:1111",
    sessionId: "uuid-1",
    sandboxSessionKey: "agent:main:dashboard:1111",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
  {
    label: "sandbox key differs from the session key",
    sessionKey: "agent:main:dashboard:2222",
    sessionId: "uuid-2",
    sandboxSessionKey: "sandbox:other",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
  {
    label: "session key blank, falls back to session id",
    sessionKey: "   ",
    sessionId: "uuid-3",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
  {
    label: "no session key at all",
    sessionId: "uuid-4",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
  {
    label: "no session key and no session id",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
  {
    label: "caller passes an explicit exec scope key",
    sessionKey: "agent:main:dashboard:5555",
    sessionId: "uuid-5",
    explicitExecScopeKey: "agent:main:process-default",
    sessionAgentId: "main",
    executionAgentId: "main",
  },
];

describe("carrier versus process tool scope keys", () => {
  it("resolves the same key for every attempt state except an explicit override", () => {
    const rows = cases.map((fields) => {
      const carrierKey = resolveProcessToolScopeKey({
        sessionKey: fields.sessionKey,
        sessionId: fields.sessionId,
        agentId: fields.sessionAgentId,
      });
      const toolsKey = resolveProcessToolScopeKey({
        scopeKey: fields.explicitExecScopeKey,
        sessionKey: fields.sessionKey?.trim() || fields.sessionId,
        sessionId: fields.sessionId,
        agentId: fields.executionAgentId,
      });
      return { label: fields.label, carrierKey, toolsKey };
    });

    for (const row of rows) {
      if (row.label === "caller passes an explicit exec scope key") {
        continue;
      }
      expect({ label: row.label, carrierKey: row.carrierKey }).toEqual({
        label: row.label,
        carrierKey: row.toolsKey,
      });
    }

    const override = rows.find((row) => row.label === "caller passes an explicit exec scope key");
    expect(override?.carrierKey).not.toEqual(override?.toolsKey);
  });

  it("shows the carrier is blind only when the session carries no scope key", () => {
    const carrierKey = resolveProcessToolScopeKey({ sessionKey: "agent:main:dashboard:6666" });

    try {
      const scoped = createProcessSessionFixture({ id: "scoped", backgrounded: true });
      scoped.scopeKey = carrierKey;
      addSession(scoped);
      const unscoped = createProcessSessionFixture({ id: "unscoped", backgrounded: true });
      addSession(unscoped);

      // The real carrier reader sees the matching session and nothing else. With a real
      // registry the unscoped session is the only shape that can hide from it, and the
      // `process` tool would still list that one because its predicate short-circuits on a
      // falsy scope (`!scopeKey || session?.scopeKey === scopeKey`).
      expect(
        listActiveProcessSessionReferences({ scopeKey: carrierKey }).map(
          (entry) => entry.sessionId,
        ),
      ).toEqual(["scoped"]);
    } finally {
      resetProcessRegistryForTests();
    }
  });
});
