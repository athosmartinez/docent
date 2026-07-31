import { z } from 'zod';

export const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});

export type AskRequest = z.infer<typeof askRequestSchema>;
