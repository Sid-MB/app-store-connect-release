# Cloudflare Worker

The Worker is the authenticated bridge between App Store Connect and GitHub. It verifies Apple's `x-apple-signature` against the exact request bytes, ignores unrelated events, and creates a `repository_dispatch` only when an app version enters `READY_FOR_DISTRIBUTION`.

The interactive CLI deploys and configures this Worker automatically. For manual deployment, see the root README.

## Configuration

| Binding | Type | Purpose |
| --- | --- | --- |
| `APPLE_WEBHOOK_SECRET` | Secret | Shared HMAC secret entered into the matching App Store Connect webhook. |
| `GITHUB_DISPATCH_TOKEN` | Secret | Fine-grained GitHub token restricted to the target repository with `Contents: write`. |
| `GITHUB_REPOSITORY` | Variable | Target in `owner/repository` form. |
| `GITHUB_API_VERSION` | Variable | GitHub REST API version; defaults to `2026-03-10`. |

Each target app repository gets its own Worker deployment and Apple webhook secret. This keeps compromise and rotation isolated to one app.
