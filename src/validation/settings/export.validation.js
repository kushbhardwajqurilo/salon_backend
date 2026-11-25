import { z } from "zod";
import { EXPORT_DOMAINS, EXPORT_FORMATS } from "../../models/settings/exportJob.model.js";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");

export const exportIdParamSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const createExportSchema = z.object({
  body: z
    .object({
      domain: z.enum(EXPORT_DOMAINS),
      format: z.enum(EXPORT_FORMATS).default("csv"),
      idempotencyKey: z.string().trim().min(8).max(128).optional(),
    })
    .strict(),
});
