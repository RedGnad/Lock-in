/*
 * Measures the Strava activities response the Strava provider actually proves over.
 *
 * Why this exists: 6.0.0 fetched `keywords=<code>` and Strava returned exactly ONE activity. 7.0.0 dropped
 * the keyword so the athlete never retitles a run, which means Strava now returns the whole list. A zkTLS
 * proof has to transport and redact the entire HTTP response, so response size is proof weight, and proof
 * weight is what killed the 4-claim provider. Two consecutive PROOF_GENERATION_FAILED on 7.0.0 make an
 * unbounded response the leading suspect: it grows with the athlete's history, so it would get worse for a
 * real user, not better.
 *
 * This runs the fetch inside the user's own logged-in Chrome over CDP, with the exact headers the provider
 * sends, because a browser address bar returns HTML while the provider asks for JSON.
 *
 * Setup:
 *   1. Quit Chrome completely.
 *   2. Start it with remote debugging:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *   3. Sign in to Strava in that Chrome.
 *   4. pnpm tsx scripts/probe-strava-response.ts
 */

export {};

const CDP = "http://127.0.0.1:9222";
const STRAVA_PAGE = "https://www.strava.com/athlete/training";

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

async function targets(): Promise<Target[]> {
  const response = await fetch(`${CDP}/json/list`);
  if (!response.ok) throw new Error(`CDP /json/list returned ${response.status}`);
  return (await response.json()) as Target[];
}

async function stravaTarget(): Promise<Target> {
  const existing = (await targets()).find((t) => t.type === "page" && t.url.includes("strava.com"));
  if (existing?.webSocketDebuggerUrl) return existing;

  await fetch(`${CDP}/json/new?${encodeURIComponent(STRAVA_PAGE)}`, { method: "PUT" });
  for (let attempt = 0; attempt < 20; ++attempt) {
    await new Promise((r) => setTimeout(r, 500));
    const opened = (await targets()).find((t) => t.type === "page" && t.url.includes("strava.com"));
    if (opened?.webSocketDebuggerUrl) return opened;
  }
  throw new Error("Could not open a strava.com tab over CDP");
}

/** Evaluates an expression in the page and returns its resolved value. */
function evaluate(socket: WebSocket, id: number, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
      };
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || "evaluation threw in the page"));
        return;
      }
      resolve(message.result?.result?.value);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

// The exact query the provider sends, minus the variant under test.
const BASE = "sport_type=Run&tags=&commute=&private_activities=&trainer=false&gear=&new_activity_only=false";
const VARIANTS = [
  { label: "7.0.0 live (keywords= empty)", query: "keywords=" },
  { label: "per_page=1", query: "keywords=&per_page=1" },
  { label: "per_page=1&page=1", query: "keywords=&per_page=1&page=1" },
  { label: "6.0.0 shape (keywords=<a title>)", query: "keywords=LI-CEA91BDAEFB2DEF1D8459F57D01" },
];

const probe = (query: string) => `
  (async () => {
    const response = await fetch("/athlete/training_activities?${query}&${BASE}", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const body = await response.text();
    let models = null;
    let firstName = null;
    let firstDistance = null;
    try {
      const parsed = JSON.parse(body);
      models = Array.isArray(parsed.models) ? parsed.models.length : null;
      firstName = parsed.models?.[0]?.name ?? null;
      firstDistance = parsed.models?.[0]?.distance_raw ?? null;
    } catch {}
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: body.length,
      models,
      firstName,
      firstDistance,
      json: body.trim().startsWith("{"),
    };
  })()
`;

const target = await stravaTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl!);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve(undefined), { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
});

console.log(`tab: ${target.url}\n`);
const results: Record<string, unknown>[] = [];
let id = 1;
for (const variant of VARIANTS) {
  try {
    const value = (await evaluate(socket, ++id, probe(variant.query))) as Record<string, unknown>;
    results.push({ variant: variant.label, ...value });
    console.log(`${variant.label}
  status      : ${value.status}  (${value.json ? "JSON" : "NOT JSON, likely an HTML page or a login redirect"})
  content-type: ${value.contentType}
  bytes       : ${value.bytes}
  models      : ${value.models}
  models[0]   : ${value.firstName} (${value.firstDistance} m)
`);
  } catch (error) {
    console.log(`${variant.label}\n  FAILED: ${error instanceof Error ? error.message : error}\n`);
  }
}
socket.close();

const live = results.find((r) => String(r.variant).startsWith("7.0.0"));
const capped = results.find((r) => r.variant === "per_page=1");
if (live && capped && typeof live.bytes === "number" && typeof capped.bytes === "number") {
  const honoured = capped.models === 1 && capped.bytes < live.bytes;
  console.log(honoured
    ? `per_page=1 is honoured: ${live.bytes} -> ${capped.bytes} bytes, ${live.models} -> 1 model. Capping the `
      + "response is a one-parameter provider change and takes proof weight back to what 6.0.0 proved over."
    : "per_page=1 is NOT honoured by Strava. The response stays unbounded and grows with the athlete's "
      + "history, so response weight has to be capped another way or the design has to change.");
}
if (live?.json === false) {
  console.log("\nThe live variant did not return JSON. Sign in to Strava in this Chrome and re-run: an "
    + "unauthenticated response would make every measurement above meaningless.");
}
