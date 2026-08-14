import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { createCustomerSchema } from "../../validation/customers/customer.validation.js";
import { normalizePhone } from "../../utils/phone.js";

describe("Inline Customer Creation & Validation Integration Tests", () => {
  describe("Phone Normalization Preprocessing", () => {
    it("should normalize formatted phone numbers before Zod validation", () => {
      const inputs = [
        "+91 98765 43210",
        "+91-98765-43210",
        "9876543210",
      ];

      for (const rawPhone of inputs) {
        const result = createCustomerSchema.safeParse({
          body: {
            name: "John Doe",
            phone: rawPhone,
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.body.phone).toBe(normalizePhone(rawPhone));
        }
      }
    });

    it("should normalize alternatePhone during schema validation", () => {
      const result = createCustomerSchema.safeParse({
        body: {
          name: "Jane Doe",
          phone: "+919876543210",
          alternatePhone: "+91 91234 56789",
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.body.alternatePhone).toBe("+919123456789");
      }
    });

    it("should reject invalid non-numeric phone formats", () => {
      const result = createCustomerSchema.safeParse({
        body: {
          name: "Invalid Customer",
          phone: "invalid-phone",
        },
      });

      expect(result.success).toBe(false);
    });
  });
});
