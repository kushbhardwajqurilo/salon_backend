import { asyncHandler } from "../utils/errors.js";

/**
 * Validates request data against a Zod schema.
 * @param {import("zod").ZodSchema} schema - The Zod schema to validate against
 */
export const validate = (schema) =>
  asyncHandler(async (req, res, next) => {
    const parsed = await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });
    // Reassign validated and stripped objects back to request
    for (const [key, value] of Object.entries(parsed)) {
      req[key] = value;
    }

    next();
  });
