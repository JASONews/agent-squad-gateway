# Agent Squad Gateway

**A local control plane and OpenAI-compatible API gateway for coding CLI models.**

**English (default)** | [简体中文](https://github.com/JASONews/agent-squad-gateway/blob/main/translations/README.zh-CN.md)

Agent Squad Gateway exposes models from locally installed coding CLIs through a managed Web UI and
OpenAI-compatible endpoints. Each provider keeps its existing local login; the Gateway adds model
aliases, API keys, access grants, concurrency controls, streaming, and capability verification.

Agent Squad Core is optional and independent. The Gateway can display Core sessions and pending
choices for debugging, but Core does not require the Gateway and the Gateway provider runtime can
operate without Core.

```text
OpenAI client / LiteLLM / IDE
            |
       /v1 API + SSE
            |
  Agent Squad Gateway + Web UI
            |
 Codex / Claude Code / Cursor Agent / OpenCode / Antigravity / Kimi Code
```

## Features

- OpenAI-compatible `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`.
- Streaming responses over SSE, including resumable Responses sessions through
  `previous_response_id`.
- Client-side function tools: the Gateway returns tool calls, while the API client executes them.
- Provider-native tools and extensions are disabled where supported and rejected at the adapter
  boundary where a CLI cannot disable them completely.
- Web UI for CLI discovery, invocation targets, verification, clients, recoverable local API keys,
  grants, run metadata, extensions, settings, and optional Core debugging.
- Per-target model, reasoning effort, isolation, streaming, queue, concurrency, timeout, and
  workspace controls.
- Version-aware capability verification: a CLI upgrade keeps the provider available while affected
  targets require conformance verification again.
- Metadata-only Gateway persistence: prompts, completions, tool payloads, and raw provider events
  are not stored in the Gateway database.

## Requirements

- Node.js 20 or newer
- npm
- At least one installed and authenticated provider CLI:
  - Codex (`codex`)
  - Claude Code (`claude`)
  - Cursor Agent (`cursor-agent`)
  - OpenCode (`opencode`)
  - Antigravity (`agy`)
  - Kimi Code (`kimi`)

## Install

### npm

Agent Squad Gateway is a public package on the npm registry. No registry token is required:

```bash
npm install -g @jasonews/agent-squad-gateway
```

Verify the command:

```bash
agent-squad-gateway --help
```

### Build From Source

```bash
git clone https://github.com/JASONews/agent-squad-gateway.git
cd agent-squad-gateway
npm ci
npm run build
npm link
```

## Quick Start

```bash
agent-squad-gateway start
agent-squad-gateway open
```

The default server address is `0.0.0.0:28772`, allowing local containers to connect. On first
start, the Gateway creates `~/.agent-squad/gateway/config.json`:

```json
{
  "address": "0.0.0.0",
  "port": 28772,
  "web_ui_auth": "disabled",
  "model_profiles": {}
}
```

For host-only access, change `address` to `127.0.0.1`. Set `web_ui_auth` to `token` when the admin
UI is reachable from an untrusted network. Restart the Gateway after editing the file.

Gateway maintains advisory default profiles for models discovered through Codex, OpenCode,
Antigravity, Claude Code, Cursor Agent, and Kimi Code. The target editor displays strengths,
weaknesses, recommended work, cost/latency tiers, and effort-specific guidance. Users can override
or add profiles with exact model IDs or `*` globs:

```json
{
  "address": "0.0.0.0",
  "port": 28772,
  "web_ui_auth": "disabled",
  "model_profiles": {
    "codex": {
      "gpt-5.6-luna": {
        "strengths": ["Local repository implementation"],
        "weaknesses": [],
        "priority": 96,
        "effort_profiles": {
          "max": {
            "recommended_for": ["careful_routine_implementation"],
            "priority": 98
          }
        }
      }
    }
  }
}
```

Broad patterns apply before specific patterns, and user profiles apply after official defaults.
Arrays replace inherited arrays; use an empty array to clear a default. Profiles are advisory and
do not guarantee provider pricing, latency, or output quality.

In the Web UI:

1. Scan installed CLIs.
2. Create and verify an invocation target. Verification performs real model calls and may consume
   quota.
3. Enable the verified target.
4. Create a client and API key.
5. Enable the OpenAI extension and grant the client access to the target.

## OpenAI-Compatible API

Use `http://127.0.0.1:28772/v1` as the base URL. Docker Desktop containers can use
`http://host.docker.internal:28772/v1`.

```bash
export AGENT_SQUAD_BASE_URL=http://127.0.0.1:28772/v1
export AGENT_SQUAD_API_KEY=asqsk_your_key

curl "$AGENT_SQUAD_BASE_URL/models" \
  -H "Authorization: Bearer $AGENT_SQUAD_API_KEY"

curl "$AGENT_SQUAD_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $AGENT_SQUAD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-gpt56-max",
    "messages": [{"role":"user","content":"Explain this repository."}],
    "stream": true
  }'
```

The model name is the enabled invocation target ID or one of its configured aliases. Unconfigured
models are rejected.

## Tool Calls

API tool calls belong to the client. Send OpenAI function definitions in the request, execute the
returned calls in the client application, and submit tool results on the next turn. The Gateway
does not expose the provider CLI's personal tools, MCP servers, skills, or workspace as API tools.

## CLI

```bash
agent-squad-gateway start [--foreground] [--address ADDRESS] [--port PORT]
agent-squad-gateway stop
agent-squad-gateway status
agent-squad-gateway open
agent-squad-gateway doctor
```

Configuration priority, from lowest to highest, is built-in defaults, `config.json`, environment
variables, and CLI options. Supported overrides include:

```bash
AGENT_SQUAD_GATEWAY_ADDRESS=127.0.0.1
AGENT_SQUAD_GATEWAY_PORT=28772
AGENT_SQUAD_GATEWAY_WEB_UI_AUTH=token
```

## Managed State

Gateway state is stored under `~/.agent-squad/gateway/`:

| Path | Purpose |
| --- | --- |
| `config.json` | Address, port, Web UI authentication, and model profile overrides |
| `gateway.db` | Targets, clients, encrypted credentials, grants, and run metadata |
| `master.key` | Encryption key for recoverable client API keys |
| `admin-secret` | Local admin bootstrap secret |
| `gateway.pid` / `gateway.log` | Background lifecycle state |
| `workspaces/` | Gateway-managed provider workspaces |

Client API keys are encrypted at rest but intentionally recoverable in the local admin UI. Protect
`gateway.db` and `master.key` together.

## Security

The Gateway is local developer infrastructure, not an internet-facing service. Do not expose it
through a public router or reverse proxy. Review [SECURITY.md](SECURITY.md) before enabling LAN or
container access, using fixed workspaces, or sending sensitive content to provider CLIs.

## Development

```bash
npm ci
npm run build
npm test
```

The default test suite uses fake providers. Real-provider tests are opt-in and may consume quota:

```bash
GATEWAY_REAL_TARGETS=target_a,target_b npm run test:real-providers
```

For UI development, run `npm run dev:server` and `npm run dev` in separate terminals.

## License

[MIT](LICENSE)
