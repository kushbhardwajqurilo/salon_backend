import { describe, expect, it } from "@jest/globals";
import { Service } from "../../models/services/service.model.js";

describe("Service Model Unit Tests", () => {
  it("should have correct model name", () => {
    expect(Service.modelName).toBe("Service");
  });

  it("should validate gender enum in schema", () => {
    const genderPath = Service.schema.path("gender");
    expect(genderPath).toBeDefined();
    expect(genderPath.enumValues).toEqual(["male", "female", "unisex"]);
    expect(genderPath.defaultValue).toBe("unisex");
  });
});
