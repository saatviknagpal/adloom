import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function getEnv(): Env {
  return schema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  });
}
