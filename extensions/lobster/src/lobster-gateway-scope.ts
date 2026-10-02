import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

/**
 * The embedded route spends the gateway's own model authority through the host
 * completion API, so it is only valid for work the gateway is handling. Follow
 * the established plugin runtime pattern and require the request scope the
 * gateway binds for the duration of a request, which is what the host completion
 * API authorizes against. A run outside that scope has no gateway authority to
 * spend, so it is refused rather than served by ambient credentials.
 */
function embeddedRouteRunsInGateway(): boolean {
  return Boolean(getPluginRuntimeGatewayRequestScope());
}

export function assertEmbeddedRouteRunsInGateway(): void {
  if (!embeddedRouteRunsInGateway()) {
    throw new Error(
      "lobster llm.invoke embedded route requires the gateway request scope; it cannot run outside the gateway process",
    );
  }
}
