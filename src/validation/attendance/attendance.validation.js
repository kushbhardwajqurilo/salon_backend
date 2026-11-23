import { z } from 'zod';

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const monthYearRegex = /^\d{4}-\d{2}$/;

export const recordStaffPunchSchema = z.object({
  body: z.object({
    staffId: z.string().regex(objectIdRegex, 'Invalid staff ID format').optional(),
    punchType: z.enum(['in', 'out'], {
      required_error: 'Punch type is required and must be "in" or "out"',
    }),
    notes: z.string().trim().max(500, 'Notes cannot exceed 500 characters').optional(),
  }),
});

export const monthlyMusterRollSchema = z.object({
  query: z.object({
    monthYear: z.string().regex(monthYearRegex, 'monthYear must be in YYYY-MM format'),
    branchId: z.union([z.string().regex(objectIdRegex, 'Invalid branch ID format'), z.literal('all')]).optional(),
    search: z.string().trim().optional(),
    status: z.enum(['present', 'late', 'early_departure', 'incomplete', 'absent', 'leave', 'all']).optional(),
  }),
});
