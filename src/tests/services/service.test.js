import { describe, expect, it } from "@jest/globals";
import { Service } from "../../models/services/service.model.js";

describe("Service Model Unit Tests", () => {
  it("should have correct model name", () => {
    expect(Service.modelName).toBe("Service");
  });
});
