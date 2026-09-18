import type { RouteMatch, Router } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { createRef, ref } from "lit/directives/ref.js";
import { isSessionRouteId } from "../app-route-paths.ts";
import { renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderLoadingState } from "../components/loading-state.ts";
import { McpAppUnmountGate } from "../components/mcp-app-unmount.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import {
  RouterOutletController,
  selectRenderedRouteMatch,
  type RouterOutletSnapshot,
} from "./router-outlet-controller.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

export { selectRenderedRouteMatch } from "./router-outlet-controller.ts";

type RenderableModule<TData> = {
  render: (data: TData | undefined, loaderPending: boolean, presented?: boolean) => unknown;
  retainOnNavigate?: boolean;
  renderOwnerKey?: (
    match: Pick<RouteMatch<string, unknown, TData>, "data" | "location">,
    settled: Pick<RouteMatch<string, unknown, TData>, "data" | "location"> | undefined,
  ) => string | undefined;
};

type RouterOutletOptions<TLoadContext = unknown> = {
  retryContext?: TLoadContext;
  presented?: boolean;
};

function isRenderableModule<TData>(module: unknown): module is RenderableModule<TData> {
  return (
    typeof module === "object" &&
    module !== null &&
    "render" in module &&
    typeof module.render === "function"
  );
}

function measureRoutedRender<T>(routeId: string, render: () => T): T {
  const startedAt = globalThis.performance?.now() ?? 0;
  const result = render();
  const durationMs = Math.round((globalThis.performance?.now() ?? startedAt) - startedAt);
  if (durationMs >= 16) {
    console.debug("[openclaw] routed render", { routeId, durationMs });
  }
  return result;
}

/**
 * Shows progress while waiting for the restarting gateway. The state lives on
 * the element rather than in render state because the reload replaces the
 * document; a re-render that resets the label is harmless, since the pending
 * wait still reloads on its own once the gateway answers.
 */
function markButtonReloading(button: HTMLButtonElement | null): () => void {
  if (!button) {
    return () => {};
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t("lazyView.reloading");
  return () => {
    button.disabled = false;
    button.textContent = label;
  };
}

/// Whether a route load was ABORTED rather than failed.
///
/// An aborted load is usually not a failure at all: `control-ui-auth` throws
/// `AbortError` the moment a gateway request is superseded, and a navigation or a
/// reload aborts the load that was in flight the same way. Reporting that as
/// "Panel failed to load" told people something had gone wrong when the only thing
/// that had happened was that a newer request took over.
export function isAbortedLoad(error: unknown): boolean {
  // Read whatever shape arrives, because it is NOT always an Error: measured
  // 2026-09-18, where an `AbortError` thrown from a route loader reaches this render
  // as a plain object whose message reads "AbortError: Gateway request is no longer
  // current". A predicate testing `instanceof Error` called that abortion a failure
  // and drew "Panel failed to load" over a panel that had merely been superseded.
  //
  // The cause chain is walked for the same reason: a wrapper that carries the abort
  // is still an abort.
  const abortPattern = /abort(ed)?\b|abort error|no longer current/i;
  const seen = new Set<unknown>();
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === "string") {
      if (abortPattern.test(current)) return true;
      break;
    }
    if (typeof current !== "object") break;
    const record = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (record.name === "AbortError") return true;
    if (typeof record.message === "string" && abortPattern.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

/// How many times an aborted load is retried in place before it IS reported.
///
/// Bounded on purpose: an abort that repeats is a real fault, and a retry loop
/// would hide it behind a spinner forever. One retry covers the ordinary
/// supersession, which is over by the time the next tick arrives.
const ABORTED_LOAD_RETRIES = 1;

/// The window those retries are counted in.
///
/// A window rather than a lifetime count, and rather than clearing the count when
/// the route renders again: a route with a retained module renders WHILE its reload
/// keeps aborting, so clearing on render reset the count on every cycle and an
/// always-aborting route retried forever (measured: 17 loads). A window also means
/// a spurious abort hours later still gets its own retry.
const ABORTED_LOAD_WINDOW_MS = 10_000;

/// Retries spent per route, and when its window started.
const abortedLoadRetries = new Map<string, { count: number; at: number }>();

function renderError<TRouteId extends string, TLoadContext, TModule, TData>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  retryContext: TLoadContext | undefined,
  error: unknown,
  routeId: TRouteId,
  render?: () => unknown,
) {
  if (retryContext !== undefined && isAbortedLoad(error)) {
    const key = String(routeId);
    const now = Date.now();
    const spent = abortedLoadRetries.get(key);
    const attempts = spent && now - spent.at < ABORTED_LOAD_WINDOW_MS ? spent.count : 0;
    if (attempts < ABORTED_LOAD_RETRIES) {
      abortedLoadRetries.set(key, { count: attempts + 1, at: now });
      // A tick later, so the router is not re-entered inside the render that is
      // still settling, and so a retry that aborts again is caught here rather
      // than recursing.
      queueMicrotask(() => {
        void router.revalidate(retryContext, routeId).catch(() => undefined);
      });
      return renderLoadingState();
    }
  }
  const staleChunk = isStaleChunkImportError(error);
  if (staleChunk) {
    // Asset failures can mean an interrupted connection or a replaced build.
    // Reload also resets failed browser imports and Vite stylesheet preloads.
    void scheduleStaleChunkReload();
  }
  const revalidate = () => {
    if (retryContext === undefined) {
      return;
    }
    void router.revalidate(retryContext, routeId).catch(() => undefined);
  };
  const handleRetry = (event: Event) => {
    if (!staleChunk) {
      revalidate();
      return;
    }
    // The Gateway may still be restarting or unreachable, so wait for it to answer
    // and then reload instead of declining on the first failed probe — a silent no-op here is
    // what drives people to a manual hard reload. Reloading against an
    // unreachable gateway would replace the recoverable panel error with a
    // fatal navigation error in app webviews, so the wait is still bounded.
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    const restoreButton = markButtonReloading(button);
    void retryStaleChunkReloadWhenReachable().then((reloading) => {
      if (reloading) {
        return;
      }
      // Vite marks CSS dependencies seen before loading them. Retrying the
      // module after a failed or blocked reload can mount it without its styles.
      restoreButton();
    });
  };
  // Resource errors alone cannot establish that a newer build exists.
  return renderLazyViewError({ error, onRetry: handleRetry, render, stale: staleChunk });
}

function renderRouterOutlet<TRouteId extends string, TLoadContext, TModule, TData = unknown>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  selection: RouterOutletSnapshot<TRouteId, TModule, TData>,
  renderedMatch: RouteMatch<TRouteId, TModule, TData> | undefined,
  options: RouterOutletOptions<TLoadContext> = {},
): unknown {
  if (renderedMatch?.status === "notFound") {
    return nothing;
  }
  if (renderedMatch?.status === "redirected") {
    return nothing;
  }
  if (!renderedMatch) {
    return nothing;
  }

  const routeId = renderedMatch.routeId;
  if (!renderedMatch?.module) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : selection.showPending
        ? renderLoadingState()
        : nothing;
  }
  const routeModule = renderedMatch.module;
  if (!isRenderableModule<TData>(routeModule)) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : null;
  }
  const renderedPage = () =>
    measureRoutedRender(routeId, () =>
      options.presented === false
        ? routeModule.render(renderedMatch.data, renderedMatch.isFetching === "loader", false)
        : routeModule.render(renderedMatch.data, renderedMatch.isFetching === "loader"),
    );
  return renderedMatch.error
    ? renderError<TRouteId, TLoadContext, TModule, TData>(
        router,
        options.retryContext,
        renderedMatch.error,
        routeId,
        routeModule.retainOnNavigate ? undefined : renderedPage,
      )
    : renderedPage();
}

type RouterOutletInputs<TRouteId extends string, TLoadContext, TModule, TData> = {
  router?: Router<TRouteId, TLoadContext, TModule, TData>;
  onNotFound?: () => boolean | void;
  notFoundRecoveryReady?: boolean;
};

class LitRouterOutletController<
  TRouteId extends string,
  TLoadContext,
  TModule,
  TData,
> implements ReactiveController {
  private readonly controller: RouterOutletController<TRouteId, TLoadContext, TModule, TData>;

  constructor(
    host: ReactiveControllerHost,
    private readonly inputs: () => RouterOutletInputs<TRouteId, TLoadContext, TModule, TData>,
  ) {
    this.controller = new RouterOutletController(() => host.requestUpdate());
    host.addController(this);
  }

  get snapshot(): RouterOutletSnapshot<TRouteId, TModule, TData> {
    return this.controller.snapshot;
  }

  hostConnected(): void {
    this.controller.setInputs(this.inputs());
    this.controller.connect();
  }

  hostUpdate(): void {
    this.controller.setInputs(this.inputs());
  }

  hostDisconnected(): void {
    this.controller.disconnect();
  }
}

/** Presentation can retire immediately while its connected subtree finishes MCP teardown. */
class OpenClawRoutePresentation extends OpenClawLightDomElement {
  @property({ attribute: false }) ownerKey = "";
  @property({ attribute: false }) renderPage: (presented: boolean) => unknown = () => nothing;
  private presentedValue = false;

  @property({ attribute: false })
  get presented(): boolean {
    return this.presentedValue;
  }
  set presented(value: boolean) {
    const previous = this.presentedValue;
    this.presentedValue = value;
    this.style.display = value ? "contents" : "none";
    this.toggleAttribute("inert", !value);
    this.setAttribute("aria-hidden", value ? "false" : "true");
    this.requestUpdate("presented", previous);
  }

  override render() {
    return this.renderPage(this.presented);
  }
}

class OpenClawRouterOutlet<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> extends OpenClawLightDomElement {
  @property({ attribute: false }) router?: Router<TRouteId, TLoadContext, TModule, TData>;
  @property({ attribute: false }) retryContext?: TLoadContext;
  @property({ attribute: false }) onNotFound?: () => boolean | void;
  @property({ attribute: false }) notFoundRecoveryReady?: boolean;
  private readonly outlet = new LitRouterOutletController(this, () => ({
    router: this.router,
    onNotFound: this.onNotFound,
    notFoundRecoveryReady: this.notFoundRecoveryReady,
  }));
  @property({ attribute: false }) retentionScope?: object;
  private readonly retainedUnmountGate = new McpAppUnmountGate(this);
  private readonly transientUnmountGate = new McpAppUnmountGate(this);
  private readonly retainedPresentation = createRef<OpenClawRoutePresentation>();
  private retainedMatch?: RouteMatch<TRouteId, TModule, TData>;
  private retainedOwnerKey?: string;
  private retainedPresented = false;
  private scopeRouter?: Router<TRouteId, TLoadContext, TModule, TData>;
  private scopeOwner?: object;
  private scopeInitialized = false;
  private scopeGeneration = 0;
  private scopeRefreshing = false;
  private retiredSessionMatches = new Set<string>();

  private synchronizeRetentionScope(router: Router<TRouteId, TLoadContext, TModule, TData>): void {
    const routerChanged = this.scopeRouter !== router;
    const changed =
      this.scopeInitialized && (routerChanged || this.scopeOwner !== this.retentionScope);
    this.scopeInitialized = true;
    this.scopeRouter = router;
    this.scopeOwner = this.retentionScope;
    if (!changed) {
      return;
    }
    const generation = ++this.scopeGeneration;
    this.retainedMatch = undefined;
    this.retainedOwnerKey = undefined;
    this.retainedPresented = false;
    this.scopeRefreshing = false;
    this.retiredSessionMatches = new Set(
      routerChanged
        ? []
        : [...router.getState().matches, ...router.getState().pendingMatches]
            .filter((match) => isSessionRouteId(match.routeId))
            .map((match) => match.id),
    );
    if (routerChanged) {
      return;
    }
    const context = this.retryContext;
    const scope = this.retentionScope;
    const state = router.getState();
    const target = state.pendingMatches[0] ?? state.matches[0];
    if (context === undefined || !target || !isSessionRouteId(target.routeId)) {
      return;
    }
    this.scopeRefreshing = true;
    // Session loader dependencies carry this same scope. Navigating the exact
    // target retires the old load without reusing its cache or changing history.
    void router
      .navigate(target.routeId, context, { history: "none", revalidate: true }, target.location)
      .finally(() => {
        if (
          this.router === router &&
          this.retentionScope === scope &&
          this.scopeGeneration === generation
        ) {
          this.scopeRefreshing = false;
          this.requestUpdate();
        }
      })
      .catch(() => undefined);
  }

  override render() {
    const router = this.router;
    if (!router) {
      return nothing;
    }
    const snapshot = this.outlet.snapshot;
    const renderedMatch = selectRenderedRouteMatch(snapshot.active, snapshot.pending);
    this.synchronizeRetentionScope(router);
    const ready = renderedMatch?.status === "success" && renderedMatch.error === undefined;
    const retiredSession =
      renderedMatch !== undefined && this.retiredSessionMatches.has(renderedMatch.id);
    const scopeReady = !this.scopeRefreshing && !retiredSession;
    const routeKey = renderedMatch ? `${renderedMatch.routeId}:${renderedMatch.status}` : "empty";
    const routeModule = renderedMatch?.module;
    const module = isRenderableModule<TData>(routeModule) ? routeModule : undefined;
    const declaredOwnerKey = renderedMatch
      ? module?.renderOwnerKey?.(renderedMatch, snapshot.settled)
      : undefined;
    const explicitOwnerKey = renderedMatch?.error === undefined ? declaredOwnerKey : undefined;
    const waiting = renderedMatch?.status === "pending" || renderedMatch?.isFetching === "loader";
    const retainPending =
      waiting && this.retainedPresented && this.retainedOwnerKey === explicitOwnerKey;
    const presentRetained =
      scopeReady &&
      module?.retainOnNavigate === true &&
      explicitOwnerKey !== undefined &&
      (ready || retainPending);
    if (presentRetained && ready) {
      this.retainedMatch = renderedMatch;
      this.retainedOwnerKey = explicitOwnerKey;
    } else if (snapshot.status === "idle" || (scopeReady && module?.retainOnNavigate && !waiting)) {
      // Invalid session destinations still replace their old owner; only a
      // successful session page opts into retention across unrelated routes.
      this.retainedMatch = undefined;
      this.retainedOwnerKey = undefined;
    }
    this.retainedPresented = presentRetained;
    const retained = this.retainedMatch;
    const retainedKey = `${this.scopeGeneration}:${this.retainedOwnerKey ?? "empty"}`;
    const transientKey = presentRetained ? "empty" : (explicitOwnerKey ?? routeKey);
    const renderTransient = () => {
      if (isSessionRouteId(renderedMatch?.routeId) && !scopeReady) {
        return !retiredSession && renderedMatch?.error !== undefined
          ? renderError(router, this.retryContext, renderedMatch.error, renderedMatch.routeId)
          : renderLoadingState();
      }
      // Returning from another page must not revive the previously selected
      // session while the requested destination is still unresolved.
      if (module?.retainOnNavigate && waiting) {
        return renderLoadingState();
      }
      return renderRouterOutlet(router, snapshot, renderedMatch, {
        retryContext: this.retryContext,
      });
    };
    const rendered = html`
      ${this.retainedUnmountGate.render(
        retainedKey,
        () =>
          retained
            ? keyed(
                retainedKey,
                html`<openclaw-route-presentation
                  ${ref(this.retainedPresentation)}
                  .ownerKey=${retainedKey}
                  .presented=${presentRetained}
                  .renderPage=${(presented: boolean) =>
                    renderRouterOutlet(router, snapshot, retained, {
                      retryContext: this.retryContext,
                      presented,
                    })}
                ></openclaw-route-presentation>`,
              )
            : nothing,
        () => (this.retainedPresentation.value ? [this.retainedPresentation.value] : []),
      )}
      ${this.transientUnmountGate.render(
        transientKey,
        () => (presentRetained ? nothing : renderTransient()),
        () => [...this.children].filter((child) => child !== this.retainedPresentation.value),
        {
          retainRenderedValue:
            !module?.retainOnNavigate &&
            explicitOwnerKey !== undefined &&
            renderedMatch?.status === "pending" &&
            renderedMatch.data === undefined,
        },
      )}
      ${presentRetained && this.retainedUnmountGate.retiring ? renderLoadingState() : nothing}
    `;
    // The gates publish retirement during render and schedule surviving MCP
    // restarts before these presentation updates. A returning owner stays inert
    // throughout teardown, even when its key matches the still-connected subtree.
    if (this.retainedPresentation.value) {
      this.retainedPresentation.value.presented =
        presentRetained &&
        !this.retainedUnmountGate.retiring &&
        this.retainedPresentation.value.ownerKey === retainedKey;
    }
    return rendered;
  }
}

if (!customElements.get("openclaw-route-presentation")) {
  customElements.define("openclaw-route-presentation", OpenClawRoutePresentation);
}

if (!customElements.get("openclaw-router-outlet")) {
  customElements.define("openclaw-router-outlet", OpenClawRouterOutlet);
}
