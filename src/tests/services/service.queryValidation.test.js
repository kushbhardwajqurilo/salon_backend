import { describe, expect, it } from "@jest/globals";
import { queryServiceSchema } from "../../validation/services/service.validation.js";

describe("Service customerGender Query Validation Tests", () => {
  it("should accept valid customerGender values", async () => {
    for (const customerGender of ["male", "female", "other", "prefer_not_to_say"]) {
      const parsed = await queryServiceSchema.parseAsync({
        query: { customerGender },
      });
      expect(parsed.query.customerGender).toBe(customerGender);
    }
  });

  it("should allow customerGender to be omitted", async () => {
    const parsed = await queryServiceSchema.parseAsync({
      query: {},
    });
    expect(parsed.query.customerGender).toBeUndefined();
  });

  it("should reject unsupported customerGender values", async () => {
    await expect(
      queryServiceSchema.parseAsync({
        query: { customerGender: "invalid_gender" },
      })
    ).rejects.toThrow();
  });

  it("should reject when both gender and customerGender are supplied together", async () => {
    const combinations = [
      { customerGender: "male", gender: "male" },
      { customerGender: "male", gender: "unisex" },
      { customerGender: "male", gender: "female" },
      { customerGender: "female", gender: "female" },
      { customerGender: "female", gender: "unisex" },
      { customerGender: "female", gender: "male" },
      { customerGender: "other", gender: "unisex" },
      { customerGender: "prefer_not_to_say", gender: "male" },
    ];

    for (const query of combinations) {
      await expect(
        queryServiceSchema.parseAsync({ query })
      ).rejects.toThrow("Cannot specify both 'gender' and 'customerGender' query parameters");
    }
  });

  it("should allow gender when customerGender is omitted", async () => {
    for (const gender of ["male", "female", "unisex"]) {
      const parsed = await queryServiceSchema.parseAsync({
        query: { gender },
      });
      expect(parsed.query.gender).toBe(gender);
      expect(parsed.query.customerGender).toBeUndefined();
    }
  });
});

