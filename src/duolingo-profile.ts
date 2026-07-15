const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const PROFILE_ID = /^[1-9]\d{0,19}$/;
const MAX_RESPONSE_BYTES = 512 * 1_024;

type PublicDuolingoProfile = Readonly<{
  id: string;
  username: string;
}>;

export function parsePublicDuolingoProfile(value: unknown, requestedUsername: string): PublicDuolingoProfile {
  if (!USERNAME.test(requestedUsername)) throw new Error("Enter a valid Duolingo username");
  if (!value || typeof value !== "object" || !Array.isArray((value as { users?: unknown }).users)) {
    throw new Error("Duolingo profile could not be resolved");
  }
  const users = (value as { users: unknown[] }).users;
  const candidate = users.find((item) => {
    if (!item || typeof item !== "object") return false;
    const username = (item as { username?: unknown }).username;
    return typeof username === "string" && username.toLowerCase() === requestedUsername.toLowerCase();
  }) as { id?: unknown; username?: unknown } | undefined;
  const id = candidate?.id === undefined ? "" : String(candidate.id);
  const username = typeof candidate?.username === "string" ? candidate.username : "";
  if (!PROFILE_ID.test(id) || BigInt(id) > (1n << 64n) - 1n || !USERNAME.test(username)) {
    throw new Error("Duolingo profile could not be resolved");
  }
  return { id, username };
}

export async function resolvePublicDuolingoProfile(usernameInput: string): Promise<PublicDuolingoProfile> {
  const username = usernameInput.trim();
  if (!USERNAME.test(username)) throw new Error("Enter a valid Duolingo username");
  const url = new URL("https://www.duolingo.com/2017-06-30/users");
  url.searchParams.set("username", username);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Duolingo profile is unavailable. Try again shortly.");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Duolingo profile response is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Duolingo returned an invalid profile response");
  }
  return parsePublicDuolingoProfile(parsed, username);
}
