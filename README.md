# idira-disco-mcp

An MCP server for the **Idira (CyberArk) Discovery & Context GraphQL API**. It lets an AI agent such as Claude Code query the inventory and send what it discovers — **secrets, machine identities (workloads) and AI agents** — to the Idira platform.

The server is a remote (Streamable HTTP) MCP server and an **OAuth 2.1 protected resource**, so it can be registered behind the **Idira Agent Identity Broker**: the agent authenticates to the broker, the broker obtains a token for this server, and every tool call is authorized and audited.

> **Status.** All 9 operations of the public schema are implemented and covered by 176 automated tests, including a test that compares the server with the documented schema field by field, and a run with a real Claude Code client. It has **not yet been run against a live Idira tenant or a live Identity Broker** — see [What is and is not verified](#what-is-and-is-not-verified).

## Tools

One tool per GraphQL root field — 100% of the [documented schema](schema/disco.graphql).

| Tool | GraphQL operation | Kind |
| --- | --- | --- |
| `disco_query_secrets` | `Query.secrets` | read |
| `disco_query_workloads` | `Query.workloads` | read |
| `disco_query_ai_agents` | `Query.aiAgents` | read |
| `disco_add_replace_secrets` | `Mutation.addReplaceExternalSecrets` | write (idempotent upsert by `originId`) |
| `disco_add_replace_workloads` | `Mutation.addReplaceExternalWorkloads` | write (idempotent upsert by `originId`) |
| `disco_add_replace_ai_agents` | `Mutation.addReplaceExternalAiAgents` | write (idempotent upsert by `originId`) |
| `disco_delete_secrets` | `Mutation.deleteExternalSecrets` | destructive |
| `disco_delete_workloads` | `Mutation.deleteExternalWorkloads` | destructive |
| `disco_delete_ai_agents` | `Mutation.deleteExternalAiAgents` | destructive |

- **Query tools** take `filter` (every documented filter field, with nested `and` / `or` / `not`), `sort` (every sortable field), `limit` / `offset`, and an optional `fields` list. They return `totalCount`, `hasMore` and `nextOffset`.
- **Add/replace tools** take up to 500 `entities` per call with every documented input field. They are forwarded upstream in batches (`DISCO_BATCH_SIZE`, default 100).
- **Delete tools** take a `filter` and refuse one without a condition. `dryRun: true` reports how many entries match, and a sample, without deleting.

## How it fits together

```
Claude Code ──OAuth 2.1──▶ Idira Agent Identity Broker ──bearer token──▶ idira-disco-mcp ──platform token──▶ Discovery & Context
 (MCP client)              https://<gateway>/mcp/<name>                  (this server)      (service user)     GraphQL API
                           authenticates the agent + user,               validates the token:
                           enforces access policy, audits                signature, issuer, expiry,
                                                                         audience, scopes
```

Two separate credentials are involved, on purpose:

1. **Inbound** — an OAuth 2.1 access token (a JWT) issued by your authorization server *for this server*. The server checks its signature against the issuer's JWKS, its issuer, expiry and audience ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)), and optional scopes. It publishes [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected resource metadata and answers `401` with a `WWW-Authenticate` challenge, which is what MCP clients and the broker's "Discover" step use.
2. **Upstream** — a short-lived Idira platform token the server obtains itself as a service user (`client_credentials` against `/oauth2/platformtoken`), cached and renewed automatically.

The inbound token is never forwarded to Idira. The MCP authorization spec forbids token passthrough, and the Discovery & Context API expects a platform token anyway.

## Try it locally (no tenant needed)

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
npm run demo
```

This starts a mock Idira tenant (it executes requests against the real documented schema), a mock authorization server and the built MCP server, and writes `.demo/mcp.json` with a valid bearer token. In a second terminal:

```bash
claude --mcp-config .demo/mcp.json --strict-mcp-config
```

Then ask Claude to, for example, *"list the secrets in the inventory, then register this Claude Code install as an AI agent"*.

## Configuration

All configuration is by environment variable; see [.env.example](.env.example). The server fails fast and lists every problem at once.

| Variable | Required | Purpose |
| --- | --- | --- |
| `IDIRA_SUBDOMAIN` | yes¹ | Tenant subdomain; the API URL becomes `https://<subdomain>.inventory.cyberark.cloud/api/graphql` |
| `IDIRA_IDENTITY_URL` | yes¹ | Identity tenant URL, e.g. `https://abc1234.id.cyberark.cloud` |
| `IDIRA_CLIENT_ID` / `IDIRA_CLIENT_SECRET` | yes | Login name and password of the service user |
| `MCP_PUBLIC_URL` | yes² | Public HTTPS URL of the MCP endpoint. It is the OAuth resource identifier, and its path is the path served |
| `OAUTH_ISSUER_URL` | yes | Issuer of the authorization server whose tokens are accepted |
| `OAUTH_AUDIENCE` | no | Accepted `aud` value(s). Defaults to `MCP_PUBLIC_URL` |
| `OAUTH_JWKS_URI` | no | Only if the issuer's metadata has no `jwks_uri` |
| `OAUTH_REQUIRED_SCOPES` | no | Scopes every request must carry |
| `OAUTH_SCOPES_READ` / `_WRITE` / `_DELETE` | no | Extra scopes per kind of tool (`403 insufficient_scope` challenge when missing) |
| `MCP_HOST` / `MCP_PORT` | no | Bind address (default `127.0.0.1:3000`) |
| `MCP_ALLOWED_HOSTS` | no | Extra accepted `Host` header values |
| `DISCO_BATCH_SIZE` | no | Entities per upstream add/replace request (default 100) |
| `DISCO_ALLOW_SECRET_VALUES` | no | Accept the `secretValue` input field. Default `false` |
| `MCP_AUTH_DISABLED` | no | Serve without authentication. Local development only; refused unless bound to loopback |
| `IDIRA_DISCO_GRAPHQL_URL`, `IDIRA_PLATFORM_TOKEN_URL`, `IDIRA_TIMEOUT_MS`, `LOG_LEVEL` | no | Overrides and tuning |

¹ Or the full-URL overrides `IDIRA_DISCO_GRAPHQL_URL` / `IDIRA_PLATFORM_TOKEN_URL`. ² Defaults to `http://localhost:<port>/mcp` for local use.

## Deploying behind the Idira Agent Identity Broker

1. **Create the service user.** In Idira: *Manage > Inventory > Identities > Users > Add User*, tick *Is OAuth confidential client*, then add the user to the **Machines Admin** role. Its login name and password are `IDIRA_CLIENT_ID` / `IDIRA_CLIENT_SECRET`. ([Create an API token](https://api-docs.cyberark.com/create-api-token/docs/create-api-token), [Authenticate to the GraphQL API](https://docs.cyberark.com/manage/latest/en/content/disco/disco-authenticate-api.htm))
2. **Choose the authorization server** that will issue tokens for this server. Any OAuth 2.1 server works if it publishes RFC 8414 or OpenID Connect discovery metadata and issues **JWT access tokens whose `aud` is `MCP_PUBLIC_URL`** (or whatever you set in `OAUTH_AUDIENCE`). Set `OAUTH_ISSUER_URL` to its issuer.
3. **Run the server** behind a TLS-terminating reverse proxy or ingress, reachable at `MCP_PUBLIC_URL`:
   ```bash
   npm ci && npm run build && npm start
   ```
   or with Docker:
   ```bash
   docker build -t idira-disco-mcp . && docker run --env-file .env -p 3000:3000 idira-disco-mcp
   ```
4. **Register it in Idira.** *Manage > Inventory > AI > MCP servers > Register custom MCP server*, enter `MCP_PUBLIC_URL`, click **Discover**. Idira reads this server's well-known metadata and detects OAuth 2.1. Choose a connection mode (table below), then **Register** and enable the server. ([Register MCP servers](https://docs.cyberark.com/manage/latest/en/content/secureai/register%20mcp%20server.htm))
5. **Register the agent and connect it.** Register Claude Code under *Managed AI agents*, then use *Connect AI agent* on the MCP server to get the Identity Broker URL (`https://<tenant-gateway-host>/mcp/<serverName>`) and client credentials. ([Secure AI agents access](https://docs.cyberark.com/manage/latest/en/content/secureai/registeragent.htm), [Connect MCP servers to AI agents](https://docs.cyberark.com/manage/latest/en/content/secureai/connect%20mcp%20servers%20to%20agents.htm))
   ```bash
   claude mcp add --transport http idira-disco https://<tenant-gateway-host>/mcp/<serverName> --client-id <client-id> --client-secret
   ```

### Connection modes

| | Keep the OAuth app in Idira (recommended) | Passthrough | None |
| --- | --- | --- | --- |
| Who gets the token for this server | Idira, as OAuth client of your authorization server (automatic with DCR, otherwise you enter a client ID and secret) | The agent brings its own token | Nobody; Idira is the only gate |
| What this server validates | Signature, issuer, expiry, audience, scopes | Same | Nothing |
| Audit in Idira | Full: user, agent, tool, server | Limited: may not identify agent or user | Not stated in the docs |
| Agent holds a credential for this server | No | Yes | No |
| Supported by this server | Yes | Yes | No — the server would accept anything that can reach its URL directly. `MCP_AUTH_DISABLED` exists for loopback development only |
| Setup effort | Medium | Low | Lowest |

Source: [Understand Secure AI agents architecture](https://docs.cyberark.com/manage/latest/en/content/secureai/architecture.htm).

## Security notes

- **Audience binding.** Tokens issued for any other resource are refused, so a token stolen from another service cannot be replayed here.
- **Asymmetric signatures only**; unsigned and shared-secret tokens are rejected. Tokens without `exp` are rejected.
- **Least privilege.** Use `OAUTH_SCOPES_READ/WRITE/DELETE` to give an agent read-only or no-delete access. The service user needs only the Machines Admin role.
- **Secret values stay out.** The inventory needs metadata about secrets, not their values. The `secretValue` input field exists in the API and is implemented, but the server rejects it unless the operator sets `DISCO_ALLOW_SECRET_VALUES=true`. Values are never logged or echoed back.
- **Deletes are irreversible.** Delete tools are annotated destructive, refuse empty filters, and offer `dryRun`. The dry run counts every entry matching the filter; the API's delete mutations are named `deleteExternal*`, so the real deletion may be limited to externally ingested entries.
- **Audit trail.** Every tool call is logged as a JSON line (tool, OAuth client, subject, outcome, duration) to stderr. Tool arguments are never logged. Upstream, calls appear as the service user; the per-agent and per-user trail is the broker's.
- **Host header allow-list** (DNS rebinding protection) is always on: the public hostname plus `MCP_ALLOWED_HOSTS`.
- `GET /healthz` is unauthenticated and returns only a static status.

## Development

```bash
npm test
```

```bash
npm run coverage
```

```bash
npm run schema:check
```

`schema:check` compares `schema/disco.graphql` with the schema currently published in the Idira docs (`-- --write` updates the local copy). If the published schema gains a field, `test/schema-coverage.test.ts` then fails until the server covers it.

| Test file | What it proves |
| --- | --- |
| `test/schema-coverage.test.ts` | Tools, input schemas, selections and enums match the documented schema exactly, in both directions; every GraphQL document validates against it |
| `test/e2e.test.ts` | A real MCP client over HTTP: OAuth challenges and metadata, nine kinds of bad token, scopes, every tool, every input and filter field reaching the API, batching, pagination, error handling |
| `test/client.test.ts` | Platform token caching and renewal, retries and backoff, error mapping |
| `test/auth.test.ts`, `test/config.test.ts` | Authorization server discovery, JWT verification details, configuration validation |

## What is and is not verified

Verified here:

- Every operation, argument, input field, output field and enum value matches the schema published at the docs URL above (checked by test, and the local schema copy is byte-identical to the published one).
- Requests are executed by a mock tenant built from that schema, with AppSync's rules for `AWSDateTime` and `AWSJSON` inputs.
- The OAuth 2.1 resource-server behaviour required by the [MCP authorization spec (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), using the official MCP TypeScript SDK v2.
- Claude Code 2.1 connecting to the built server with a bearer token and calling the tools.

Not verified — needs a real tenant:

- **Live API behaviour** beyond the published schema: page-size and batch-size limits, error formats, rate limits, and whether `AWSJSON` is enforced as assumed.
- **The Identity Broker end to end**: the *Discover* step against this server, and the token it presents. In particular, confirm that your authorization server issues JWT access tokens with the right audience; opaque tokens are not supported (no RFC 7662 introspection).
- **Claude Code's redirect URL in agent registration.** Claude Code uses a loopback callback (`http://localhost:<port>/callback`, fixable with `--callback-port`). The docs say custom agent redirect URLs must be HTTPS; whether the predefined *Claude* agent type accepts Claude Code's loopback callback needs checking in the tenant.
- The public schema exposes no risk details (only a `riskId` filter), although the docs mention viewing risks; there is nothing to implement for that yet.

## License

MIT
