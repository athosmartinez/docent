import { z } from 'zod';

export const costsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((query) => !query.from || !query.to || query.to > query.from, {
    message: 'to must be after from',
    path: ['to'],
  });

export type CostsQuery = z.infer<typeof costsQuerySchema>;
