import { describe, expect, it } from "vitest";
import { assertEmbeddedRouteRunsInGateway } from "./lobster-gateway-scope.js";

// These run with no gateway request scope bound, which is the state a plugin
// loaded outside the gateway would be in.
describe("lobster gateway scope", () => {
  it("refuses the embedded route outside a gateway request scope", () => {
    expect(() => assertEmbeddedRouteRunsInGateway()).toThrow("gateway request scope");
  });
});
