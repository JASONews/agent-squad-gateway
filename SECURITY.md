# Security Policy

Agent Squad Gateway runs local coding CLIs and exposes a network API. Treat it as local developer
infrastructure, not as an internet-facing service.

## Network Boundary

- The default `0.0.0.0` bind address supports local container access but also exposes the port to
  reachable host networks. Use `127.0.0.1` when LAN or container access is unnecessary.
- Do not expose the Gateway through a public router, tunnel, or reverse proxy.
- Web UI authentication defaults to `disabled`. Use `web_ui_auth: "token"` on any untrusted
  network. The `/v1` API always requires a Gateway client API key.
- CORS is disabled and is not a substitute for a firewall or authentication.

## Credentials and State

- Client API keys are encrypted at rest but intentionally recoverable in the local Web UI.
- Protect `gateway.db` and `master.key` together. Disclosure of both exposes stored client keys;
  losing `master.key` makes those keys unrecoverable.
- Never commit GitHub tokens, npm tokens, provider credentials, generated Gateway state, or local
  `.npmrc` files.

## Provider Boundaries

- Gateway SQLite persistence excludes prompts, completions, tool payloads, and raw provider events,
  but provider CLIs may retain their own transcripts.
- Provider isolation, sandboxing, cancellation, and transcript suppression are best-effort CLI
  integrations, not operating-system security boundaries.
- API clients own function execution. Provider-native tool activity is disabled where supported and
  rejected by adapters where a CLI cannot disable tools completely.
- Antigravity currently receives prompt content as a command-line argument, which can be visible to
  local process inspection or audit tooling.
- Fixed workspaces reduce isolation. Review the selected path and acknowledgement before enabling a
  target.

## Verification

Target verification sends bounded requests to the configured provider model and may consume quota.
Run it intentionally and review provider account limits before enabling automatic consumers.

## Reporting Vulnerabilities

Report security issues privately to the repository owner. Do not include live credentials, private
repository content, prompts, or provider transcripts in public issues.
