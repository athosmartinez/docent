import { z } from 'zod';

export const ingestRequestSchema = z.object({
  source: z.string().min(1),
  include: z.string().min(1).default('**/*.md'),
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
