interface Env {
  APPLE_WEBHOOK_SECRET: string;
  GITHUB_DISPATCH_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_API_VERSION?: string;
}

interface AppStoreConnectEvent {
  data?: {
    type?: string;
    id?: string;
    attributes?: {
      newValue?: string;
      oldValue?: string;
      timestamp?: string;
    };
    relationships?: unknown;
  };
}

const EXPECTED_EVENT_TYPE = "appStoreVersionAppVersionStateUpdated";
const EXPECTED_STATE = "READY_FOR_DISTRIBUTION";

/** Return a JSON response while keeping every endpoint response machine-readable. */
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Convert binary HMAC output into the lowercase hexadecimal format Apple places in x-apple-signature. */
function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare equal-length strings without returning early on the first mismatch. */
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Authenticate the exact raw request bytes with the shared HMAC-SHA256 secret configured in App Store Connect. */
async function verifyAppleSignature(rawBody: ArrayBuffer, signatureHeader: string | null, secret: string): Promise<boolean> {
  const supplied = signatureHeader?.match(/^hmacsha256=([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  if (!supplied || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToHex(await crypto.subtle.sign("HMAC", key, rawBody));
  return constantTimeEqual(expected, supplied);
}

/** Forward only the release-worthy event to GitHub's authenticated repository_dispatch endpoint. */
async function dispatchToGitHub(event: AppStoreConnectEvent, env: Env): Promise<Response> {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_DISPATCH_TOKEN) return jsonResponse({ error: "Worker GitHub configuration is incomplete." }, 500);
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "app-store-connect-release-worker",
      "X-GitHub-Api-Version": env.GITHUB_API_VERSION ?? "2026-03-10"
    },
    body: JSON.stringify({
      event_type: "app_store_ready_for_distribution",
      client_payload: {
        apple_event: event,
        received_at: new Date().toISOString(),
        source: "app-store-connect"
      }
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    return jsonResponse({ error: "GitHub rejected repository_dispatch.", status: response.status, detail }, 502);
  }
  return jsonResponse({ accepted: true, dispatched: true }, 202);
}

export default {
  /** Accept authenticated Apple deliveries, acknowledge tests and irrelevant states, and dispatch READY_FOR_DISTRIBUTION exactly once per GitHub release tag. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return jsonResponse({ service: "app-store-connect-release", healthy: true, repository: env.GITHUB_REPOSITORY });
    if (request.method !== "POST" || url.pathname !== "/") return jsonResponse({ error: "Not found." }, 404);

    const rawBody = await request.arrayBuffer();
    if (!(await verifyAppleSignature(rawBody, request.headers.get("x-apple-signature"), env.APPLE_WEBHOOK_SECRET))) {
      return jsonResponse({ error: "Invalid App Store Connect signature." }, 401);
    }

    let event: AppStoreConnectEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonResponse({ error: "Invalid JSON payload." }, 400);
    }

    if (event.data?.type !== EXPECTED_EVENT_TYPE || event.data.attributes?.newValue !== EXPECTED_STATE) {
      return jsonResponse({ accepted: true, dispatched: false, reason: "Event does not represent READY_FOR_DISTRIBUTION." });
    }
    return dispatchToGitHub(event, env);
  }
};
