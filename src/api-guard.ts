const JSON_CONTENT_TYPE = "application/json";

export function assertSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    throw new Error("Cross-site requests are not allowed");
  }

  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  if (!origin || !host) return;

  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    originHost = parsed.host;
  } catch {
    throw new Error("Invalid request origin");
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) {
    throw new Error("Cross-origin requests are not allowed");
  }
}

export async function readJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  assertSameOrigin(request);
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith(JSON_CONTENT_TYPE)) {
    throw new Error("Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Request body is too large");
  }
  const payload = await request.arrayBuffer();
  if (payload.byteLength === 0 || payload.byteLength > maxBytes) {
    throw new Error(payload.byteLength === 0 ? "Request body is empty" : "Request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}
