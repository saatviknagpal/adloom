import { addMessage, getGeminiHistory, getSession } from "@/server/services/session";
import { streamChat } from "@/server/services/gemini";

type Params = Promise<{ id: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const { id } = await ctx.params;
  const session = await getSession(id);
  if (!session) return new Response("Session not found", { status: 404 });
  if (session.status !== "chatting") {
    return new Response("Session is no longer in chat phase", { status: 400 });
  }

  const body = (await req.json()) as { message: string; imageUrl?: string };
  if (!body.message?.trim()) return new Response("Empty message", { status: 400 });

  await addMessage(id, "user", body.message, body.imageUrl);

  const history = getGeminiHistory(
    session.messages.map((m) => ({ role: m.role, content: m.content })),
  );

  const encoder = new TextEncoder();
  let fullResponse = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamChat(history, body.message)) {
          fullResponse += chunk;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
        }
        await addMessage(id, "assistant", fullResponse);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
