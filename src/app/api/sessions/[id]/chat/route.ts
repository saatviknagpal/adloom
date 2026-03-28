import { addMessage, createSnapshot, getGeminiHistory, getSession } from "@/server/services/session";
import { streamChat, extractBeatsFromText } from "@/server/services/gemini";

type Params = Promise<{ id: string }>;

function looksLikeBeatList(text: string): boolean {
  const numbered = (text.match(/^\s*\d+\.\s+\*?\*?/gm) ?? []).length;
  const hasBeatKeywords = /\b(hook|problem|reveal|cta|beat)\b/i.test(text);
  return numbered >= 3 && hasBeatKeywords;
}

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
  let toolCallFired = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamChat(history, body.message)) {
          if (event.type === "text") {
            fullResponse += event.text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.text })}\n\n`));
          }

          if (event.type === "tool_call" && event.name === "save_beat_list") {
            toolCallFired = true;
            const msg = await addMessage(id, "assistant", fullResponse);
            fullResponse = "";
            const snapshot = await createSnapshot(
              id,
              JSON.stringify(event.args),
              msg.id,
              (event.args as { label?: string }).label,
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  snapshot: {
                    id: snapshot.id,
                    version: snapshot.version,
                    label: snapshot.label,
                    content: event.args,
                  },
                })}\n\n`,
              ),
            );
          }
        }

        if (fullResponse) {
          const msg = await addMessage(id, "assistant", fullResponse);

          if (!toolCallFired && looksLikeBeatList(fullResponse)) {
            try {
              const extracted = await extractBeatsFromText(fullResponse);
              if (extracted) {
                const parsed = JSON.parse(extracted);
                const snapshot = await createSnapshot(
                  id,
                  extracted,
                  msg.id,
                  parsed.label ?? "Revised draft",
                );
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      snapshot: {
                        id: snapshot.id,
                        version: snapshot.version,
                        label: snapshot.label,
                        content: parsed,
                      },
                    })}\n\n`,
                  ),
                );
              }
            } catch {
              // fallback extraction failed — not critical
            }
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
        controller.close();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`));
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
