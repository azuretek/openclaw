import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  extractErrorCode,
  toErrorObject as toLintErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
        approvalId?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export type LobsterRunnerParams = {
  action: "run" | "resume";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approvalId?: string;
  approve?: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type LobsterRunner = {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
};

type EmbeddedLlmAdapter = {
  source?: string;
  invoke: (params: {
    env?: Record<string, string | undefined>;
    args?: Record<string, unknown>;
    payload: unknown;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

type EmbeddedToolContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
};

type EmbeddedToolEnvelope = {
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    prompt: string;
    items: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
  error?: {
    message: string;
  };
};

type EmbeddedToolRuntime = {
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
  resumeToolRequest: (params: {
    token?: string;
    approvalId?: string;
    approved?: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
};

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  if (!isPathInside(base, resolved)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      if (bytes > maxBytes) {
        callback(new Error(`lobster ${label} exceeded maxStdoutBytes`));
        return;
      }
      callback();
    },
  });
}

function normalizeEnvelope(
  envelope: EmbeddedToolEnvelope,
  maxStdoutBytes: number,
): Extract<LobsterEnvelope, { ok: true }> {
  if (!envelope.ok) {
    throw new Error(envelope.error?.message ?? "lobster runtime failed");
  }
  if (envelope.status === "needs_input") {
    throw new Error("Lobster input requests are not supported by the OpenClaw Lobster tool yet");
  }
  const normalized: Extract<LobsterEnvelope, { ok: true }> = {
    ok: true,
    status: envelope.status ?? "ok",
    output: Array.isArray(envelope.output) ? envelope.output : [],
    requiresApproval: envelope.requiresApproval
      ? {
          type: "approval_request",
          prompt: envelope.requiresApproval.prompt,
          items: envelope.requiresApproval.items,
          ...(envelope.requiresApproval.resumeToken
            ? { resumeToken: envelope.requiresApproval.resumeToken }
            : {}),
          ...(envelope.requiresApproval.approvalId
            ? { approvalId: envelope.requiresApproval.approvalId }
            : {}),
        }
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") > maxStdoutBytes) {
    throw new Error("lobster runtime result exceeded maxStdoutBytes");
  }
  return normalized;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|") || !workflowExts.has(path.extname(trimmed).toLowerCase())) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  try {
    if (!(await stat(resolved)).isFile()) {
      throw new Error("Workflow path is not a file");
    }
    return resolved;
  } catch (error) {
    if (/\s/.test(trimmed) && extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  // Joined specifier keeps bundlers from statically resolving
  // @clawdbot/lobster/core; the plugin's declared @clawdbot/lobster dependency
  // provides it at runtime, so it is a used direct dependency.
  const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(coreSpecifier)) as EmbeddedToolRuntime;
}

/**
 * Lobster resolves a sole registered direct adapter before it consults its
 * environment auto-detect, so a workflow step that omits `--provider` would
 * move to the in-process `embedded` adapter on upgrade instead of the Gateway
 * HTTP route it used before. Pin the provider Lobster would have auto-detected
 * (`LOBSTER_PI_LLM_ADAPTER_URL`, then `OPENCLAW_URL`/`CLAWD_URL`, then
 * `LOBSTER_LLM_ADAPTER_URL`) whenever the workflow has not chosen a route of
 * its own. Lobster reads a step's `--provider` before `LOBSTER_LLM_PROVIDER`,
 * so naming `embedded` still selects the registered direct adapter.
 */
function resolveEmbeddedEnv(
  base: NodeJS.ProcessEnv,
  llmAdapters?: Record<string, EmbeddedLlmAdapter>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (!llmAdapters) {
    return env;
  }
  if ((env.LOBSTER_LLM_PROVIDER ?? "").trim()) {
    return env;
  }
  const detected = (env.LOBSTER_PI_LLM_ADAPTER_URL ?? "").trim()
    ? "pi"
    : (env.OPENCLAW_URL ?? env.CLAWD_URL ?? "").trim()
      ? "openclaw"
      : (env.LOBSTER_LLM_ADAPTER_URL ?? "").trim()
        ? "http"
        : "";
  if (detected) {
    // A workflow with a route of its own keeps Lobster's existing behaviour,
    // reuse of its saved results on that route included.
    env.LOBSTER_LLM_PROVIDER = detected;
    return env;
  }
  // With no route of its own, this run can only reach the embedded adapter, which
  // spends the gateway's model authority through the host completion API. A replay
  // authorizes nothing, because Lobster's run-state and persistent-cache branches
  // return a saved result before the adapter is consulted, so the embedded route
  // is executed by the gateway rather than replayed.
  env.LOBSTER_LLM_FORCE_REFRESH = "1";
  return env;
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
        const ctx: EmbeddedToolContext = {
          cwd: params.cwd,
          env: resolveEmbeddedEnv(process.env, options?.llmAdapters),
          mode: "tool",
          stdin: Readable.from([]),
          stdout: createLimitedSink(maxStdoutBytes, "stdout"),
          stderr: createLimitedSink(maxStdoutBytes, "stderr"),
          signal,
          ...(options?.llmAdapters ? { llmAdapters: options.llmAdapters } : {}),
        };
        let envelope: EmbeddedToolEnvelope;

        if (params.action === "run") {
          const pipeline = params.pipeline?.trim() ?? "";
          if (!pipeline) {
            throw new Error("pipeline required");
          }

          const filePath = await detectWorkflowFile(pipeline, params.cwd);
          if (filePath) {
            const parsedArgsJson = params.argsJson?.trim() ?? "";
            let args: Record<string, unknown> | undefined;
            if (parsedArgsJson) {
              try {
                args = JSON.parse(parsedArgsJson) as Record<string, unknown>;
              } catch {
                throw new Error("run --args-json must be valid JSON");
              }
            }
            envelope = await runtime.runToolRequest({ filePath, args, ctx });
          } else {
            envelope = await runtime.runToolRequest({ pipeline, ctx });
          }
        } else {
          const token = params.token?.trim() ?? "";
          const approvalId = params.approvalId?.trim() ?? "";
          if (!token && !approvalId) {
            throw new Error("token or approvalId required");
          }
          if (typeof params.approve !== "boolean") {
            throw new Error("approve required");
          }
          envelope = await runtime.resumeToolRequest({
            ...(token ? { token } : {}),
            ...(approvalId ? { approvalId } : {}),
            approved: params.approve,
            ctx,
          });
        }
        return normalizeEnvelope(envelope, maxStdoutBytes);
      });
    },
  };
}
