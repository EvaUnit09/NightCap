type BodyError = "invalid_request" | "invalid_json" | "too_large";

export async function readJsonBody(
  request: Request,
  maxChars: number,
  oversizeCode: BodyError = "too_large",
): Promise<unknown> {
  const raw = await request.text().catch(() => null);
  if (raw === null) return badRequest("invalid_request");
  if (raw.length > maxChars) return badRequest(oversizeCode);
  try {
    return JSON.parse(raw);
  } catch {
    return badRequest("invalid_json");
  }
}

function badRequest(error: BodyError): Response {
  return Response.json({ error }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
