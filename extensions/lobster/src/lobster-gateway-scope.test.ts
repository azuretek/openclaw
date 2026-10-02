import { describe, expect, it } from "vitest";
import {
  assertEmbeddedRouteRunsInGateway,
  embeddedRouteRunsInGateway,
} from "./lobster-gateway-scope.js";

// These run with no gateway request scope bound, which is the state a plugin
// loaded outside the gateway would be in.
describe("lobster gateway scope", () => {
  it("reports that no gateway request scope is bound", () => {
    expect(embeddedRouteRunsInGateway()).toBe(false);
  });

  it("refuses the embedded route outside a gateway request scope", () => {
    expect(() => assertEmbeddedRouteRunsInGateway()).toThrow("gateway request scope");
  });
});
