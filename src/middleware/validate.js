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
      if (req[key] && typeof req[key] === "object" && !Array.isArray(req[key])) {
        Object.keys(req[key]).forEach(k => delete req[key][k]);
        Object.assign(req[key], value);
      } else {
        req[key] = value;
      }
    }

    next();
  });
