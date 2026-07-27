import { appendFileSync } from "node:fs";
import { sign } from "node:crypto";

const APP_STORE_CONNECT_API = "https://api.appstoreconnect.apple.com";
const EXPECTED_EVENT_TYPE = "appStoreVersionAppVersionStateUpdated";
const EXPECTED_STATE = "READY_FOR_DISTRIBUTION";

/** Read a GitHub Action input using the environment naming convention implemented by the runner. */
function getInput(name, required = false) {
  const value = process.env[`INPUT_${name.toUpperCase().replaceAll(" ", "_")}`]?.trim() ?? "";
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

/** Parse the exact true and false spellings accepted by GitHub's Actions toolkit. */
function getBooleanInput(name) {
  const value = getInput(name, true).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Input ${name} must be true or false.`);
}

/** Set a multiline-safe Action output through the runner's output file. */
function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const delimiter = `asc_release_${Math.random().toString(16).slice(2)}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Add the release result to the workflow's rendered job summary. */
function addSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Encode a value using the unpadded base64url representation required by JWT. */
function encodeBase64Url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/** Generate Apple's short-lived ES256 JWT for either a team key or an individual key. */
function createAppStoreConnectToken({ issuerId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const claims = { iat: now, exp: now + 19 * 60, aud: "appstoreconnect-v1", ...(issuerId ? { iss: issuerId } : { sub: "user" }) };
  const signingInput = `${encodeBase64Url(header)}.${encodeBase64Url(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey.replaceAll("\\n", "\n"), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Read and validate the normalized App Store Connect event forwarded by the Worker. */
function parseEvent(payloadJson) {
  const envelope = JSON.parse(payloadJson);
  const event = envelope.apple_event ?? envelope;
  if (!event?.data || typeof event.data !== "object") throw new Error("The dispatch payload does not contain an App Store Connect event.");
  return event;
}

/** Retrieve the marketing version and platform because Apple's webhook intentionally contains only the App Store version resource ID. */
async function readAppStoreVersion({ token, versionId }) {
  const fields = encodeURIComponent("platform,versionString,appVersionState,appStoreState");
  const response = await fetch(`${APP_STORE_CONNECT_API}/v1/appStoreVersions/${encodeURIComponent(versionId)}?fields[appStoreVersions]=${fields}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.errors?.map((error) => error.detail ?? error.title).filter(Boolean).join("; ");
    throw new Error(`App Store Connect returned ${response.status} while reading version ${versionId}${detail ? `: ${detail}` : "."}`);
  }
  return body.data;
}

/** Replace the documented release template placeholders without evaluating arbitrary expressions. */
function renderTemplate(template, values) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template);
}

/** Call GitHub's REST API using the caller repository's short-lived GITHUB_TOKEN. */
async function githubRequest(method, path, token, body) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "app-store-connect-release-action",
      "X-GitHub-Api-Version": "2026-03-10"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  return { response, payload };
}

/** Return an existing release for a tag, or null when the tag has not been released. */
async function getReleaseByTag({ owner, repo, tag, token }) {
  const result = await githubRequest("GET", `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
  if (result.response.status === 404) return null;
  if (!result.response.ok) throw new Error(`GitHub returned ${result.response.status} while reading release ${tag}: ${result.payload?.message ?? "Unknown error"}`);
  return result.payload;
}

/** Format the authenticated, non-secret Apple event details that are useful for release provenance. */
function buildEventMetadata({ event, version, tag }) {
  const attributes = event.data.attributes ?? {};
  return [
    "## App Store distribution",
    "",
    `- Version: \`${version.attributes.versionString}\``,
    `- Platform: \`${version.attributes.platform}\``,
    `- Tag: \`${tag}\``,
    `- State: \`${attributes.oldValue ?? "UNKNOWN"}\` → \`${attributes.newValue}\``,
    `- App Store event: \`${event.data.id}\``,
    `- App Store version resource: \`${version.id}\``,
    `- Reported at: ${attributes.timestamp ?? "Unknown"}`,
    ""
  ].join("\n");
}

/** Create the release once, treating a replay or concurrent creation as an idempotent success. */
async function createRelease({ owner, repo, tag, name, body, generateReleaseNotes, token }) {
  const existing = await getReleaseByTag({ owner, repo, tag, token });
  if (existing) return { release: existing, created: false };
  const result = await githubRequest("POST", `/repos/${owner}/${repo}/releases`, token, {
    tag_name: tag,
    name,
    body,
    draft: false,
    prerelease: false,
    generate_release_notes: generateReleaseNotes,
    make_latest: "true"
  });
  if (result.response.status === 422) {
    const racedRelease = await getReleaseByTag({ owner, repo, tag, token });
    if (racedRelease) return { release: racedRelease, created: false };
  }
  if (!result.response.ok) throw new Error(`GitHub returned ${result.response.status} while creating release ${tag}: ${result.payload?.message ?? "Unknown error"}`);
  return { release: result.payload, created: true };
}

/** Run the GitHub Action for a single authenticated App Store Connect status event. */
async function run() {
  const event = parseEvent(getInput("payload-json", true));
  const attributes = event.data.attributes ?? {};
  if (event.data.type !== EXPECTED_EVENT_TYPE || attributes.newValue !== EXPECTED_STATE) {
    console.log(`Ignoring ${event.data.type ?? "unknown event"} with state ${attributes.newValue ?? "unknown"}.`);
    setOutput("created", "false");
    return;
  }

  const versionId = event.data.relationships?.instance?.data?.id;
  if (!versionId) throw new Error("The App Store Connect event does not contain an appStoreVersions instance ID.");

  const appStoreToken = createAppStoreConnectToken({
    issuerId: getInput("app-store-connect-issuer-id"),
    keyId: getInput("app-store-connect-key-id", true),
    privateKey: getInput("app-store-connect-private-key", true)
  });
  const version = await readAppStoreVersion({ token: appStoreToken, versionId });
  const versionString = version?.attributes?.versionString;
  const platform = version?.attributes?.platform;
  if (!versionString || !platform) throw new Error(`App Store Connect version ${versionId} did not include versionString and platform.`);

  const tag = renderTemplate(getInput("tag-template") || "v{version}", { version: versionString });
  const name = renderTemplate(getInput("release-name-template") || "{tag}", { version: versionString, tag, platform });
  const repository = process.env.GITHUB_REPOSITORY?.split("/");
  if (repository?.length !== 2) throw new Error("GITHUB_REPOSITORY is unavailable or invalid.");
  const [owner, repo] = repository;
  const githubToken = getInput("github-token", true);

  const tagResult = await githubRequest("GET", `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, githubToken);
  if (tagResult.response.status === 404) throw new Error(`Required tag ${tag} does not exist in ${owner}/${repo}. This action never creates or moves tags.`);
  if (!tagResult.response.ok) throw new Error(`GitHub returned ${tagResult.response.status} while verifying tag ${tag}: ${tagResult.payload?.message ?? "Unknown error"}`);

  const result = await createRelease({
    owner,
    repo,
    tag,
    name,
    body: getBooleanInput("include-event-metadata") ? buildEventMetadata({ event, version, tag }) : undefined,
    generateReleaseNotes: getBooleanInput("generate-release-notes"),
    token: githubToken
  });

  setOutput("created", String(result.created));
  setOutput("release-url", result.release.html_url);
  setOutput("tag", tag);
  addSummary(`## ${result.created ? "GitHub release created" : "GitHub release already exists"}\n\n[${tag}](${result.release.html_url}) for App Store version ${versionString} (${platform}).`);
}

run().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
