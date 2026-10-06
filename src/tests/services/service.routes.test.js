import { describe, expect, it } from "@jest/globals";
import serviceRouter from "../../routers/services/service.routes.js";

describe("Service Router Unit Tests", () => {
  it("should export service router instance", () => {
    expect(serviceRouter).toBeDefined();
  });
});
