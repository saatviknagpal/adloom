import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generateImageJob } from "@/inngest/functions/generateImageJob";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateImageJob],
});
