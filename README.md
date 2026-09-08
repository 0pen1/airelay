# airelay

> 通过手机远程控制本机 AI Agent 会话。端到端加密，中继不可读。

支持 Claude Code、Codex、Gemini CLI 等多种 CLI Agent。手机和本机均无公网 IP，通过一台公网 VPS 中继。中继仅做加密消息路由，无法解密终端通信内容。

## 架构

```
[手机浏览器]  ──WSS + E2E──►  [公网 VPS 中继]  ◄──WSS──  [本机 Agent]
  xterm.js                     只见密文             tmux control mode
  语音输入                     WebSocket 路由       E2E 加密
  多主机切换                   SQLite 认证          ↕
  会话管理 UI                                      claude / codex / … 进程
```

## 特性

- **端到端加密**：ECDH P-256 密钥交换 + AES-256-GCM 对称加密，中继只见密文
- **前向安全**：每次连接生成新 ECDH 密钥对，历史密钥泄露不影响未来会话
- **会话持久**：Agent 进程重启后，tmux 托管的 AI 会话继续存活，可重新接入
- **多 Agent**：通过 `agents.json` 配置，新增一个 CLI Agent 只需加一行
- **多主机**：手机可配对多台主机，切换连接
- **安全认证**：Agent 用 HMAC-SHA256，手机用一次性 JWT + 可复用 session_token
- **断线重连**：手机网络中断后凭 session_token 自动重连，无需重新扫码
- **语音输入**：浏览器原生 Web Speech API（iOS 需 Safari）
- **排他锁**：同一会话同时只允许一个手机接入
- **热重载**：`airelay agent reload` 重新加载 agents.json，不中断运行中的会话

## 包结构

| 包 | 说明 |
|----|------|
| `packages/shared` | 协议类型定义、HMAC/JWT 加密、校验工具 |
| `packages/relay`  | VPS 中继服务（Node.js + ws + node:sqlite） |
| `packages/agent`  | 本机 daemon（tmux control mode 驱动 + E2E 加密 + WS 客户端） |
| `packages/web`    | 手机前端（xterm.js + E2E 加密 + Web Speech API） |

## 文档

| 文档 | 内容 |
|------|------|
| [CLAUDE.md](CLAUDE.md)               | AI 开发指导（系统概览、关键规则、常用操作） |
| [docs/architecture.md](docs/architecture.md) | 系统架构、E2E 加密、WebSocket 协议、会话生命周期 |
| [docs/glossary.md](docs/glossary.md)         | 术语表（host/agent/session/relay） |
| [docs/protocol.md](docs/protocol.md)         | WebSocket 消息协议完整定义 |
| [docs/security.md](docs/security.md)         | 威胁模型、加密算法、攻击场景分析 |
| [docs/development.md](docs/development.md)   | 开发环境搭建、构建、测试、调试 |
| [docs/deployment.md](docs/deployment.md)     | VPS 部署：systemd、TLS 反代、防火墙、备份、升级 |

## 快速开始

### 环境要求

- Node.js 22.5+（中继使用内置 `node:sqlite`）
- tmux（本机）
- 现代浏览器（手机端）

### 安装

```bash
git clone https://github.com/0pen1/airelay.git
cd airelay
npm install
npm run build
```

### VPS 侧（中继）

```bash
cd packages/relay
node dist/index.js init                           # 初始化 SQLite
node dist/index.js register <host_id> <host_secret>  # 注册主机
node dist/index.js start                          # 启动（配合 nginx 做 TLS）
```

### 本机侧（Agent）

```bash
cd packages/agent
node dist/index.js setup          # 生成 host 身份
node dist/index.js agent _run     # 启动 daemon（或 agent start 写入 launchd）
node dist/index.js gen-token      # 终端打印 QR 码
```

### 手机侧

扫描 QR 码 → 自动连接 → E2E 加密握手 → 查看/控制 Agent 会话

## E2E 加密

```
Phone                       Relay                        Agent
  │                           │                            │
  │── e2e_hello (ECDH pub) ──►│── forward ──────────────►  │
  │                           │                            │ verify sig
  │                           │                            │ derive key
  │  ◄── e2e_ack (ECDH pub) ──│◄── forward ───────────── │
  │ verify sig                │                            │
  │ derive key                │                            │
  │                           │                            │
  │ AES-256-GCM ══════════════│════════════════════════════│
  │                        只见密文                         │
```

- **密钥交换**：ECDH P-256 + HMAC 签名（防 MITM）
- **对称加密**：AES-256-GCM（认证加密，防篡改）
- **密钥派生**：HKDF-SHA256
- **前向安全**：每次连接新密钥对

详见 [docs/security.md](docs/security.md)。

## 开发

```bash
npm run build                    # 构建全部包

# 或分包构建：
packages/shared/node_modules/.bin/tsc -p packages/shared/tsconfig.json
packages/relay/node_modules/.bin/tsc -p packages/relay/tsconfig.json
packages/agent/node_modules/.bin/tsc -p packages/agent/tsconfig.json
cd packages/web && npm run build
```

详见 [docs/development.md](docs/development.md)。

## License

MIT
