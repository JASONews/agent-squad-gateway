# Agent Squad Gateway

**面向本地编程 CLI 模型的控制平面与 OpenAI 兼容 API Gateway。**

[English](https://github.com/JASONews/agent-squad-gateway/blob/main/README.md) | **简体中文**

Agent Squad Gateway 将本机已安装并登录的编程 CLI 模型，通过 Web 管理界面和 OpenAI
兼容接口提供给 LiteLLM、IDE 或其他 API 客户端。Gateway 负责模型别名、API Key、访问授权、
并发控制、流式输出与能力验证；各 CLI 继续使用自己的本地登录状态。

Agent Squad Core 是可选且独立的。Gateway 可以读取 Core 会话和待处理选择用于调试，但 Core
不依赖 Gateway，Gateway 的 provider runtime 也可以在没有 Core 时独立运行。

```text
OpenAI 客户端 / LiteLLM / IDE
            |
       /v1 API + SSE
            |
  Agent Squad Gateway + Web UI
            |
 Codex / Claude Code / Cursor Agent / OpenCode / Antigravity
```

## 主要功能

- 兼容 `GET /v1/models`、`POST /v1/chat/completions` 和 `POST /v1/responses`。
- 通过 SSE 返回流式响应；Responses API 可使用 `previous_response_id` 恢复会话。
- 客户端工具调用：Gateway 返回 tool call，实际函数由 API 客户端执行。
- 支持在 Web UI 中管理 CLI、调用目标、验证、客户端、可恢复的本地 API Key、授权、运行元数据、
  extension、设置和可选的 Core 调试信息。
- 每个 target 可配置模型、reasoning effort、隔离级别、流式模式、队列、并发、超时与 workspace。
- CLI 版本变化后 provider 仍保持 Available，只要求受影响的 target 重新验证。
- Gateway 数据库只保存元数据，不保存 prompt、completion、tool payload 或 provider 原始事件。

## 环境要求

- Node.js 20 或更新版本
- npm
- 至少安装并登录一个 provider CLI：
  - Codex：`codex`
  - Claude Code：`claude`
  - Cursor Agent：`cursor-agent`
  - OpenCode：`opencode`
  - Antigravity：`agy`

## 安装

### GitHub Packages

当前私有 GitHub Packages 测试版本需要一个具备 package 读取权限的 GitHub token：

```bash
npm config set @jasonews:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"
npm install -g @jasonews/agent-squad-gateway@0.1.0

agent-squad-gateway --help
```

### 从源码构建

```bash
git clone https://github.com/JASONews/agent-squad-gateway.git
cd agent-squad-gateway
npm ci
npm run build
npm link
```

## 快速开始

```bash
agent-squad-gateway start
agent-squad-gateway open
```

默认监听 `0.0.0.0:28772`，因此本地容器可以访问。首次启动会创建
`~/.agent-squad/gateway/config.json`：

```json
{
  "address": "0.0.0.0",
  "port": 28772,
  "web_ui_auth": "disabled"
}
```

只允许本机访问时，请把 `address` 改为 `127.0.0.1`。当管理界面可能被不可信网络访问时，
请把 `web_ui_auth` 改为 `token`。修改后需要重启 Gateway。

在 Web UI 中依次完成：

1. 扫描本机 CLI。
2. 创建并验证 invocation target。验证会真实调用模型，可能消耗额度。
3. 启用验证成功的 target。
4. 创建 client 和 API Key。
5. 启用 OpenAI extension，并授权 client 使用指定 target。

## OpenAI 兼容接口

本机使用 `http://127.0.0.1:28772/v1`；Docker Desktop 容器可使用
`http://host.docker.internal:28772/v1`。

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
    "messages": [{"role":"user","content":"解释这个仓库。"}],
    "stream": true
  }'
```

请求中的 model 是已启用 target 的 ID 或其 alias。未配置的模型会被拒绝。

## 工具调用边界

API tool call 属于客户端：客户端在请求中提交 OpenAI function 定义，执行 Gateway 返回的调用，
再在下一轮提交工具结果。Gateway 不会把 provider CLI 的个人工具、MCP server、skill 或 workspace
作为 API 工具暴露。

## CLI

```bash
agent-squad-gateway start [--foreground] [--address ADDRESS] [--port PORT]
agent-squad-gateway stop
agent-squad-gateway status
agent-squad-gateway open
agent-squad-gateway doctor
```

配置优先级从低到高为：内置默认值、`config.json`、环境变量、CLI 参数。支持的环境变量包括：

```bash
AGENT_SQUAD_GATEWAY_ADDRESS=127.0.0.1
AGENT_SQUAD_GATEWAY_PORT=28772
AGENT_SQUAD_GATEWAY_WEB_UI_AUTH=token
```

## 本地状态

Gateway 状态保存在 `~/.agent-squad/gateway/`。其中 `gateway.db` 保存 target、client、加密凭据、
授权和运行元数据；`master.key` 用于解密可恢复的 API Key；`workspaces/` 保存 Gateway 管理的
provider workspace。API Key 可以在本地管理界面中重新显示，因此必须同时保护 `gateway.db` 和
`master.key`。

## 安全

Gateway 是本地开发基础设施，不是公网服务。不要通过公网路由器或反向代理暴露它。启用局域网或
容器访问、使用固定 workspace、或处理敏感内容前，请阅读 [SECURITY.md](../SECURITY.md)。

## 开发与测试

```bash
npm ci
npm run build
npm test
```

默认测试使用 fake provider，不会调用真实模型。真实 provider 测试必须显式指定 target，且可能
消耗额度：

```bash
GATEWAY_REAL_TARGETS=target_a,target_b npm run test:real-providers
```

## License

[MIT](../LICENSE)
