import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

export const createCouponSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1, "Coupon code is required").max(50),
      description: z.string().trim().max(1000).optional().default(""),
      discountType: z.enum(["fixed", "percentage"], {
        errorMap: () => ({ message: "discountType must be either 'fixed' or 'percentage'" }),
      }),
      discountValue: z.number().positive("discountValue must be greater than 0"),
      validFrom: z.coerce.date({ invalid_type_error: "validFrom must be a valid date" }),
      validUntil: z.coerce.date({ invalid_type_error: "validUntil must be a valid date" }),
      status: z.enum(["active", "inactive"]).optional().default("active"),
      totalUsageLimit: z
        .number()
        .int("totalUsageLimit must be an integer")
        .positive("totalUsageLimit must be positive")
        .nullable()
        .optional(),
      perCustomerLimit: z
        .number()
        .int("perCustomerLimit must be an integer")
        .positive("perCustomerLimit must be positive")
        .nullable()
        .optional(),
      excludedBranchIds: z.array(objectIdSchema).optional().default([]),
    })
    .strict("Unknown fields are not allowed in create coupon payload")
    .refine(
      (data) => {
        if (data.discountType === "percentage") {
          return data.discountValue <= 100;
        }
        return true;
      },
      {
        message: "Percentage discountValue cannot exceed 100",
        path: ["discountValue"],
      }
    )
    .refine(
      (data) => {
        return new Date(data.validUntil).getTime() > new Date(data.validFrom).getTime();
      },
      {
        message: "validUntil must be strictly later than validFrom",
        path: ["validUntil"],
      }
    ),
});

export const updateCouponSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z
    .object({
      description: z.string().trim().max(1000).optional(),
      discountType: z.enum(["fixed", "percentage"]).optional(),
      discountValue: z.number().positive("discountValue must be greater than 0").optional(),
      validFrom: z.coerce.date().optional(),
      validUntil: z.coerce.date().optional(),
      status: z.enum(["active", "inactive"]).optional(),
      totalUsageLimit: z
        .number()
        .int("totalUsageLimit must be an integer")
        .positive("totalUsageLimit must be positive")
        .nullable()
        .optional(),
      perCustomerLimit: z
        .number()
        .int("perCustomerLimit must be an integer")
        .positive("perCustomerLimit must be positive")
        .nullable()
        .optional(),
      excludedBranchIds: z.array(objectIdSchema).optional(),
    })
    .strict("Unknown or forbidden fields are not allowed in update coupon payload")
    .refine(
      (data) => {
        if (data.discountType === "percentage" && data.discountValue !== undefined) {
          return data.discountValue <= 100;
        }
        return true;
      },
      {
        message: "Percentage discountValue cannot exceed 100",
        path: ["discountValue"],
      }
    )
    .refine(
      (data) => {
        if (data.validFrom && data.validUntil) {
          return new Date(data.validUntil).getTime() > new Date(data.validFrom).getTime();
        }
        return true;
      },
      {
        message: "validUntil must be strictly later than validFrom",
        path: ["validUntil"],
      }
    ),
});

export const updateCouponStatusSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z
    .object({
      status: z.enum(["active", "inactive"], {
        errorMap: () => ({ message: "Status must be either 'active' or 'inactive'" }),
      }),
    })
    .strict("Only status field is accepted"),
});

export const getCouponParamsSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const queryCouponsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
    search: z.string().trim().optional(),
    status: z.enum(["active", "inactive", "all"]).optional().default("all"),
  }),
});

