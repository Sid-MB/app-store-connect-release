#!/usr/bin/env node

// cli/src/index.js
import { confirm, input, password, select } from "@inquirer/prompts";
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
var APPLE_API = "https://api.appstoreconnect.apple.com";
var APPLE_KEYS_URL = "https://appstoreconnect.apple.com/access/integrations/api";
var WORKFLOW_PATH = ".github/workflows/app-store-connect-release.yml";
var GITHUB_API_VERSION = "2026-03-10";
var EVENT_TYPE = "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED";
function step(message) {
  process.stdout.write(`
\u203A ${message}
`);
}
function run(command2, args, options = {}) {
  const capture = options.capture ?? false;
  const result = spawnSync(command2, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : [options.input === void 0 ? "inherit" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"]
  });
  if (result.error) throw new Error(`Unable to run ${command2}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command2} exited with status ${result.status}${detail ? `:
${detail}` : "."}`);
  }
  return result;
}
function requireCommand(command2, installHint) {
  const result = run(command2, ["--version"], { capture: true, allowFailure: true });
  if (result.status !== 0) throw new Error(`${command2} is required. ${installHint}`);
}
function encodeBase64Url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}
function createAppleToken({ keyType, issuerId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const claims = { iat: now, exp: now + 19 * 60, aud: "appstoreconnect-v1", ...keyType === "team" ? { iss: issuerId } : { sub: "user" } };
  const signingInput = `${encodeBase64Url(header)}.${encodeBase64Url(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}
function appleRequest(method, path, token, body) {
  const args = ["--silent", "--show-error", "--request", method, "--header", `Authorization: Bearer ${token}`, "--header", "Accept: application/json"];
  if (body !== void 0) args.push("--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  args.push(`${APPLE_API}${path}`);
  const result = run("curl", args, { capture: true, allowFailure: true });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = {};
  }
  if (result.status !== 0 || parsed.errors) {
    const details = parsed.errors?.map((error) => error.detail ?? error.title).filter(Boolean).join("; ") ?? result.stderr.trim();
    throw new Error(`App Store Connect request ${method} ${path} failed${details ? `: ${details}` : "."}`);
  }
  return parsed;
}
function expandPath(path) {
  return resolve(path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}
function inferKeyId(privateKeyPath) {
  return basename(privateKeyPath).match(/^AuthKey_([a-z0-9]{10})\.p8$/i)?.[1]?.toUpperCase() ?? "";
}
function setGitHubSecret(repository, name, value) {
  run("gh", ["secret", "set", name, "--repo", repository], { input: value });
}
function callerWorkflow() {
  return `name: Publish App Store release

on:
  repository_dispatch:
    types:
      - app_store_ready_for_distribution

permissions:
  contents: write

jobs:
  release:
    uses: Sid-MB/app-store-connect-release/.github/workflows/release.yml@v1
    with:
      payload-json: \${{ toJSON(github.event.client_payload) }}
      tag-template: v{version}
    secrets:
      APP_STORE_CONNECT_KEY_ID: \${{ secrets.APP_STORE_CONNECT_KEY_ID }}
      APP_STORE_CONNECT_PRIVATE_KEY: \${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
      APP_STORE_CONNECT_ISSUER_ID: \${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
`;
}
function installWorkflow(repository, defaultBranch) {
  const existing = run("gh", ["api", "--method", "GET", `repos/${repository}/contents/${WORKFLOW_PATH}`, "-f", `ref=${defaultBranch}`], { capture: true, allowFailure: true });
  if (existing.status === 0) {
    step(`${WORKFLOW_PATH} already exists; leaving it unchanged.`);
    return;
  }
  const content = Buffer.from(callerWorkflow()).toString("base64");
  run("gh", ["api", "--method", "PUT", `repos/${repository}/contents/${WORKFLOW_PATH}`, "-f", "message=Configure App Store release automation", "-f", `content=${content}`, "-f", `branch=${defaultBranch}`], { capture: true });
  step(`Committed ${WORKFLOW_PATH} to ${defaultBranch}.`);
}
function readWorkerUrl(outputPath, fallbackOutput) {
  const records = existsSync(outputPath) ? readFileSync(outputPath, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
    }
  }) : [];
  const target = records.findLast((record) => record.type === "deploy")?.targets?.find((value) => value.startsWith("https://"));
  const fallback = fallbackOutput.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/g)?.at(-1);
  if (!target && !fallback) throw new Error("Wrangler deployed the Worker, but its public workers.dev URL could not be determined.");
  return target ?? fallback;
}
function upsertAppleWebhook({ app, token, workerUrl, webhookSecret, repository }) {
  const existing = appleRequest("GET", `/v1/apps/${encodeURIComponent(app.id)}/webhooks?fields%5Bwebhooks%5D=enabled,eventTypes,name,url&limit=200`, token);
  const match = existing.data?.find((webhook) => webhook.attributes?.url === workerUrl);
  const attributes = { enabled: true, eventTypes: [EVENT_TYPE], name: `GitHub release: ${repository}`.slice(0, 100), secret: webhookSecret, url: workerUrl };
  if (match) {
    appleRequest("PATCH", `/v1/webhooks/${encodeURIComponent(match.id)}`, token, { data: { type: "webhooks", id: match.id, attributes } });
    return { id: match.id, updated: true };
  }
  const created = appleRequest("POST", "/v1/webhooks", token, {
    data: {
      type: "webhooks",
      attributes,
      relationships: { app: { data: { type: "apps", id: app.id } } }
    }
  });
  return { id: created.data.id, updated: false };
}
function testAppleWebhook(webhookId, token) {
  appleRequest("POST", "/v1/webhookPings", token, {
    data: {
      type: "webhookPings",
      relationships: { webhook: { data: { type: "webhooks", id: webhookId } } }
    }
  });
}
function testGitHubDispatchToken(repository, token) {
  const result = run("curl", [
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--request",
    "POST",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "--header",
    "Content-Type: application/json",
    "--data-binary",
    JSON.stringify({ event_type: "app_store_connect_setup_test", client_payload: { configured: true } }),
    `https://api.github.com/repos/${repository}/dispatches`
  ], { capture: true });
  if (result.stdout.trim() !== "204") throw new Error(`GitHub dispatch credential test returned HTTP ${result.stdout.trim()}.`);
}
async function setup() {
  process.stdout.write("App Store Connect \u2192 GitHub Release setup\n");
  process.stdout.write("This installer will deploy one Cloudflare Worker, configure one Apple webhook, add GitHub Actions secrets, and commit one workflow file.\n");
  requireCommand("git", "Install Git: https://git-scm.com/downloads");
  requireCommand("gh", "Install GitHub CLI: https://cli.github.com/");
  requireCommand("curl", "Install curl and try again.");
  requireCommand("npx", "Install Node.js 22 or newer: https://nodejs.org/");
  const repositoryRootResult = run("git", ["rev-parse", "--show-toplevel"], { capture: true, allowFailure: true });
  if (repositoryRootResult.status !== 0) throw new Error("Run this command from inside the GitHub repository you want to configure.");
  const repositoryRoot = repositoryRootResult.stdout.trim();
  if (run("gh", ["auth", "status"], { capture: true, allowFailure: true }).status !== 0) {
    step("GitHub CLI needs authentication. Follow the prompts from gh auth login.");
    run("gh", ["auth", "login"], { inherit: true });
  }
  const repositoryInfo = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,viewerPermission"], { cwd: repositoryRoot, capture: true }).stdout);
  const repository = repositoryInfo.nameWithOwner;
  const defaultBranch = repositoryInfo.defaultBranchRef.name;
  const approved = await confirm({ message: `Configure ${repository} and commit the listener workflow directly to ${defaultBranch}?`, default: true });
  if (!approved) throw new Error("Setup cancelled.");
  step(`Create an App Store Connect API key at ${APPLE_KEYS_URL}`);
  process.stdout.write("Use a team key with App Manager access, or an individual key belonging to an Account Holder, Admin, or App Manager. Download the .p8 file now; Apple only offers it once.\n");
  const keyType = await select({
    message: "Which App Store Connect API key did you create?",
    choices: [
      { name: "Team key (App Manager access)", value: "team" },
      { name: "Individual key (user is App Manager or higher)", value: "individual" }
    ]
  });
  const issuerId = keyType === "team" ? await input({ message: "Paste the Issuer ID:", validate: (value) => value.trim() ? true : "Issuer ID is required for a team key." }) : "";
  const privateKeyPath = await input({ message: "Paste or drag the downloaded .p8 file path here:", validate: (value) => existsSync(expandPath(value.trim())) ? true : "That file does not exist." });
  const expandedPrivateKeyPath = expandPath(privateKeyPath.trim());
  const inferredKeyId = inferKeyId(expandedPrivateKeyPath);
  if (inferredKeyId) step(`Inferred App Store Connect Key ID ${inferredKeyId} from ${basename(expandedPrivateKeyPath)}.`);
  const keyId = inferredKeyId || await input({ message: "The .p8 filename is nonstandard. Paste the Key ID:", validate: (value) => value.trim() ? true : "Key ID is required." });
  const privateKey = readFileSync(expandedPrivateKeyPath, "utf8").trim();
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error("The selected .p8 file is not a valid private key.");
  }
  const appleToken = createAppleToken({ keyType, issuerId: issuerId.trim(), keyId: keyId.trim(), privateKey });
  step("Reading the apps available to this App Store Connect key.");
  const appsResponse = appleRequest("GET", "/v1/apps?fields%5Bapps%5D=name,bundleId,sku&limit=200", appleToken);
  if (!appsResponse.data?.length) throw new Error("This App Store Connect key cannot access any apps.");
  const appId = await select({
    message: "Which app should publish releases to this repository?",
    choices: appsResponse.data.map((app2) => ({ name: `${app2.attributes.name} (${app2.attributes.bundleId})`, value: app2.id }))
  });
  const app = appsResponse.data.find((candidate) => candidate.id === appId);
  const tokenUrl = new URL("https://github.com/settings/personal-access-tokens/new");
  tokenUrl.searchParams.set("name", `App Store release: ${basename(repository)}`);
  tokenUrl.searchParams.set("description", `Dispatch App Store release events to ${repository}`);
  tokenUrl.searchParams.set("target_name", repository.split("/")[0]);
  tokenUrl.searchParams.set("expires_in", "90");
  tokenUrl.searchParams.set("contents", "write");
  step(`Create a fine-grained GitHub token at:
${tokenUrl}`);
  process.stdout.write(`Select \u201COnly select repositories\u201D, choose ${repository}, keep Contents: write, and create the token. The Worker uses it only to call repository_dispatch.
`);
  const dispatchToken = await password({ message: "Paste the fine-grained GitHub token:", mask: true, validate: (value) => value.trim() ? true : "A token is required." });
  step("Authenticating Cloudflare Wrangler.");
  if (run("npx", ["--yes", "wrangler@4", "whoami"], { capture: true, allowFailure: true }).status !== 0) {
    run("npx", ["--yes", "wrangler@4", "login"], { inherit: true });
  }
  run("npx", ["--yes", "wrangler@4", "whoami"], { capture: true });
  const workerName = `asc-release-${repository}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").replaceAll(/-+/g, "-").slice(0, 63).replace(/-$/, "");
  const webhookSecret = randomBytes(32).toString("hex");
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "asc-release-"));
  const outputPath = resolve(temporaryDirectory, "wrangler.ndjson");
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const workerConfig = resolve(cliDirectory, "../../worker/wrangler.jsonc");
  try {
    step(`Deploying Cloudflare Worker ${workerName}.`);
    const deployment = run("npx", ["--yes", "wrangler@4", "deploy", "--config", workerConfig, "--name", workerName, "--var", `GITHUB_REPOSITORY:${repository}`, "--var", `GITHUB_API_VERSION:${GITHUB_API_VERSION}`], {
      capture: true,
      env: { WRANGLER_OUTPUT_FILE_PATH: outputPath }
    });
    process.stdout.write(deployment.stdout);
    const workerUrl = readWorkerUrl(outputPath, deployment.stdout);
    step("Uploading Worker secrets. Their values are never written to this repository.");
    run("npx", ["--yes", "wrangler@4", "secret", "bulk", "--config", workerConfig, "--name", workerName], {
      input: JSON.stringify({ APPLE_WEBHOOK_SECRET: webhookSecret, GITHUB_DISPATCH_TOKEN: dispatchToken.trim() })
    });
    step("Installing App Store Connect credentials as GitHub Actions secrets.");
    setGitHubSecret(repository, "APP_STORE_CONNECT_KEY_ID", keyId.trim());
    setGitHubSecret(repository, "APP_STORE_CONNECT_PRIVATE_KEY", privateKey);
    if (keyType === "team") {
      setGitHubSecret(repository, "APP_STORE_CONNECT_ISSUER_ID", issuerId.trim());
    } else {
      run("gh", ["secret", "delete", "APP_STORE_CONNECT_ISSUER_ID", "--repo", repository], { capture: true, allowFailure: true });
    }
    step("Installing the repository_dispatch listener.");
    installWorkflow(repository, defaultBranch);
    step("Validating the GitHub dispatch credential.");
    testGitHubDispatchToken(repository, dispatchToken.trim());
    step(`${upsertAppleWebhook({ app, token: appleToken, workerUrl, webhookSecret, repository }).updated ? "Updated" : "Created"} the App Store Connect webhook.`);
    const webhooks = appleRequest("GET", `/v1/apps/${encodeURIComponent(app.id)}/webhooks?fields%5Bwebhooks%5D=enabled,eventTypes,name,url&limit=200`, appleToken);
    const webhook = webhooks.data.find((candidate) => candidate.attributes?.url === workerUrl);
    if (!webhook) throw new Error("The webhook was created but could not be read back from App Store Connect.");
    step("Requesting Apple's signed test delivery.");
    testAppleWebhook(webhook.id, appleToken);
    const health = run("curl", ["--silent", "--show-error", "--fail", workerUrl], { capture: true });
    const healthPayload = JSON.parse(health.stdout);
    if (!healthPayload.healthy || healthPayload.repository !== repository) throw new Error("The Worker health response does not match the configured repository.");
    process.stdout.write(`
Setup complete.

`);
    process.stdout.write(`App: ${app.attributes.name} (${app.attributes.bundleId})
`);
    process.stdout.write(`Repository: https://github.com/${repository}
`);
    process.stdout.write(`Worker: ${workerUrl}
`);
    process.stdout.write(`Webhook ID: ${webhook.id}
`);
    process.stdout.write(`Workflow: https://github.com/${repository}/blob/${defaultBranch}/${WORKFLOW_PATH}

`);
    process.stdout.write("When Apple sends READY_FOR_DISTRIBUTION, the workflow will require an existing tag named v<version>, generate release notes, append the authenticated Apple event metadata, and publish the release.\n");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
function printHelp() {
  process.stdout.write(`Usage: asc-release setup

Run from the GitHub repository that should receive releases. The interactive setup configures GitHub, Cloudflare Workers, and App Store Connect without writing credentials to disk.

Commands:
  setup     Configure the current repository (default).
  --help    Show this help.
`);
}
var command = process.argv[2] ?? "setup";
if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
} else if (command === "setup") {
  setup().catch((error) => {
    process.stderr.write(`
Setup failed: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
} else {
  printHelp();
  process.exitCode = 1;
}
