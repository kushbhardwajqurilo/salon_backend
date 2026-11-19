import { z } from 'zod';

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const createStaffDeviceMappingSchema = z.object({
  body: z.object({
    staffId: z.string().regex(objectIdRegex, 'Invalid staff ID format'),
    provider: z.string().trim().min(1, 'Provider is required').max(50, 'Provider name too long'),
    deviceId: z.string().trim().min(1, 'Device ID is required').max(100, 'Device ID too long'),
    externalEmployeeCode: z
      .string()
      .trim()
      .min(1, 'External employee code is required')
      .max(100, 'External employee code too long'),
    notes: z.string().trim().max(500, 'Notes cannot exceed 500 characters').optional(),
    effectiveFrom: z
      .string()
      .datetime({ message: 'effectiveFrom must be a valid ISO datetime' })
      .optional(),
  }),
});

export const updateStaffDeviceMappingSchema = z.object({
  params: z.object({
    id: z.string().regex(objectIdRegex, 'Invalid mapping ID format'),
  }),
  body: z.object({
    notes: z.string().trim().max(500, 'Notes cannot exceed 500 characters').optional(),
    mappingStatus: z.enum(['mapped', 'unmapped', 'partial', 'unknown']).optional(),
    effectiveTo: z
      .string()
      .datetime({ message: 'effectiveTo must be a valid ISO datetime' })
      .optional()
      .nullable(),
  }),
});

export const staffDeviceMappingIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(objectIdRegex, 'Invalid mapping ID format'),
  }),
});

export const queryStaffDeviceMappingSchema = z.object({
  query: z.object({
    staffId: z.string().regex(objectIdRegex, 'Invalid staff ID format').optional(),
    provider: z.string().trim().optional(),
    deviceId: z.string().trim().optional(),
    externalEmployeeCode: z.string().trim().optional(),
    mappingStatus: z.enum(['mapped', 'unmapped', 'partial', 'unknown']).optional(),
    isActive: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        if (typeof val === 'boolean') return val;
        return val === 'true';
      }),
    search: z.string().trim().optional(),
    page: z
      .union([z.number(), z.string()])
      .optional()
      .transform((val) => (val ? Math.max(1, parseInt(String(val), 10) || 1) : 1)),
    limit: z
      .union([z.number(), z.string()])
      .optional()
      .transform((val) => (val ? Math.min(100, Math.max(1, parseInt(String(val), 10) || 20)) : 20)),
  }),
});
