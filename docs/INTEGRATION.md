# Integration guide: Idira Identity

This guide sets up `idira-disco-mcp` with **Idira Identity as the OAuth 2.1 authorization server**: users sign in with Idira Identity, Idira Identity issues the access token, and the MCP server validates it. It ends with connecting Claude Code, either through the Idira Agent Identity Broker or directly for a first test.

> **Read this first.** The steps come from the Idira documentation and from a published setup for another MCP server that uses Idira Identity the same way. They have **not been run against a live tenant by this project**. A few values differ between tenants and app types, so [Part 3](#part-3-check-what-your-tenant-issues) has you read them from your own tenant instead of trusting this page. Every statement that is not from the official docs is marked *(to confirm)*.

## What you are setting up

```
                    ┌──────────────── Idira Identity ────────────────┐
                    │  Authorization app          Service user        │
                    │  (issues access tokens)     (Machines Admin)    │
                    └───────┬─────────────────────────────┬──────────┘
        sign-in + token     │                             │ platform token
                            ▼                             ▼
Claude Code ─▶ Identity Broker ─▶ idira-disco-mcp ─▶ Discovery & Context API
```

Three things live in Idira Identity, and they are easy to confuse:

| Object | Used for | Becomes |
| --- | --- | --- |
| **Service user** in the Machines Admin role | The MCP server's own calls to the Discovery & Context API | `IDIRA_CLIENT_ID`, `IDIRA_CLIENT_SECRET` |
| **Authorization app** (custom web app) | Issuing the access tokens that callers present to the MCP server | `OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE` |
| **OAuth client** for the Identity Broker or Claude Code | Requesting tokens from the authorization app | Entered in the broker or in Claude Code, never in the MCP server |

Keep the service user and the OAuth client separate. The service user can write to and delete from your inventory; the OAuth client only needs to be allowed to ask for tokens.

## Before you begin

You need an Idira Identity administrator, and these values:

| Value | Example | Where it comes from |
| --- | --- | --- |
| Identity tenant URL | `https://abc1234.id.cyberark.cloud` | Your Idira Identity sign-in URL |
| Tenant subdomain | `acme` | The first label of `acme.inventory.cyberark.cloud` |
| Public URL of the MCP server | `https://disco-mcp.example.com/mcp` | Where you will host it, behind TLS |
| Application ID for the new app | `discomcp` | You choose it in Part 2; letters and digits only keeps URLs simple |

## Part 1: Create the service user

1. Go to **Manage > Inventory > Identities > Users** and click **Add User**.
2. Enter a login name (for example `svc-disco-mcp@cyberark.cloud.1234`), a display name and a strong password.
3. In the **Status** checklist select **Is OAuth confidential client**. *Is Service User* and *Password never expires* are selected automatically.
4. Click **Create User**.
5. Go to **Manage > Inventory > Identities > Roles**, open **Machines Admin** and add the service user as a member.

The login name is `IDIRA_CLIENT_ID` and the password is `IDIRA_CLIENT_SECRET`. Service users do not appear under active users; look under **All Service Users**.

Source: [Create an API token](https://api-docs.cyberark.com/create-api-token/docs/create-api-token), [Authenticate to the GraphQL API](https://docs.cyberark.com/manage/latest/en/content/disco/disco-authenticate-api.htm).

## Part 2: Create the authorization app

Idira Identity has two custom app templates that can issue the token. Use the first unless Part 3 shows it does not work in your tenant.

| | OAuth2 Server app (recommended) | OpenID Connect app |
| --- | --- | --- |
| Intended for | Access tokens for another application's API — this case | Signing users in to an application |
| Token audience (`aud`) | A string you set on the app | The client ID used in the request *(to confirm)* |
| Token format | You choose: JWT or opaque | JWT |
| Evidence it works with an MCP server | Official docs only | Published, working setup for another MCP server |
| Setup effort | Low | Low |

### Option A: custom OAuth2 Server app

1. Go to **Manage > Identities > Web apps**, click **Add Web Apps**, open the **Custom** tab and click **Add** next to **OAuth2 Server**. Confirm, then close the catalog.
2. **Settings** page:
   - **Application ID**: `discomcp`. It becomes part of the endpoint URLs.
   - **Application Name**: `Discovery & Context MCP`.
3. **General Usage** page:
   - **Client ID Type**: `Confidential` if every client can keep a secret, which is the case for the Identity Broker. Choose `Anything` if a public client using PKCE without a secret must also work; the docs name it as the setting for the Authorization Code flow.
   - **Issuer**: leave the default.
   - **Audience**: your MCP server's public URL, `https://disco-mcp.example.com/mcp`. Any string is accepted; using the URL keeps the token bound to this one server.
   - **Allowed Redirects**: add the redirect URL of each client. For the Identity Broker it is the Redirect URL shown while registering the MCP server (Part 5). For direct Claude Code testing add `http://localhost:8765/callback`.
4. **Tokens** page:
   - **Token Type**: `JwtRS256`. This is required: the MCP server validates JWTs and cannot use opaque tokens.
   - **Auth Methods**: enable **Auth Code**.
   - **Token Lifespan**: more than 10 minutes; one hour is a reasonable start.
   - **Issue refresh tokens**: enable, with *Rotate tokens after use*, so clients are not sent back to sign in every hour.
5. **Permissions** page: add the role or roles whose members may use the MCP server. Only these users can obtain a token.
6. Click **Save**.

Source: [Custom OAuth2 Server](https://docs.cyberark.com/manage/latest/en/content/identity/coreservices/authenticate/oauth2-server.htm), [Configure OAuth 2.0 flows](https://docs.cyberark.com/manage/latest/en/content/identity/coreservices/authenticate/oauthcreate.htm).

### Option B: custom OpenID Connect app

1. Go to **Manage > Identities > Web apps**, click **Add Web Apps**, open the **Custom** tab and click **Add** next to **OpenID Connect**.
2. **Settings**: set the **Application ID** to `discomcp`.
3. **Trust**: add the **Authorized Redirect URIs** of each client (wildcards are not supported). After saving, note the generated **Client ID** and **Client Secret**.
4. **Tokens**: signing algorithm `RS256`, lifetime one hour, scopes `openid profile` *(to confirm)*.
5. **Permissions**: add the users or roles who may use the MCP server.

With this option the token audience is the **Client ID** rather than a string you choose *(to confirm)*, so use this app for the MCP server only: every token it issues is then meant for this server.

Source: [Add and configure the custom OpenID Connect application](https://docs.cyberark.com/manage/latest/en/content/identity/applications/appscustom/openidaddconfigapp.htm); values marked *(to confirm)* come from the [mcp-privilege-cloud setup guide](https://github.com/aaearon/mcp-privilege-cloud/blob/main/docs/CYBERARK_IDENTITY_SETUP.md).

### The OAuth client

The client ID and secret that the Identity Broker or Claude Code presents:

- **Option A**: OAuth2 apps in Idira Identity do not generate their own client credentials. A confidential client is a **service user** marked *Is OAuth confidential client*: its login name is the client ID and its password the client secret *(to confirm)*. Create a second service user for this, do **not** add it to Machines Admin, and add it on the app's **Permissions** page.
- **Option B**: use the Client ID and Client Secret from the app's **Trust** page.

## Part 3: Check what your tenant issues

Do not skip this. It gives you the two values the MCP server needs, and it catches most problems before the server is involved.

**1. Find the discovery document.** Replace the tenant and Application ID:

```bash
curl -s https://abc1234.id.cyberark.cloud/discomcp/.well-known/openid-configuration
```

You should get JSON containing `issuer`, `authorization_endpoint`, `token_endpoint` and `jwks_uri`, with the Application ID in the paths. The reported shape is:

| Field | Reported value *(to confirm)* |
| --- | --- |
| `issuer` | `https://abc1234.id.cyberark.cloud/discomcp/` — note the trailing slash |
| `authorization_endpoint` | `https://abc1234.id.cyberark.cloud/OAuth2/Authorize/discomcp` |
| `token_endpoint` | `https://abc1234.id.cyberark.cloud/OAuth2/Token/discomcp` |
| `jwks_uri` | `https://abc1234.id.cyberark.cloud/OAuth2/Keys/discomcp` |

The `issuer` value, copied exactly, is your `OAUTH_ISSUER_URL`.

Do not use the tenant-level document at `https://abc1234.id.cyberark.cloud/.well-known/openid-configuration`. It describes the tenant itself, not your app, and tokens from your app will not match it.

If the app-specific URL answers 404 for an OAuth2 Server app, use Option B: this server needs a discovery document, and so do MCP clients.

**2. Get a token and read its claims.** Complete one sign-in with your client (Part 5), or request a token with any OAuth tool using the endpoints above, then decode the payload:

```bash
echo "<access-token>" | cut -d. -f2 | base64 -d 2>/dev/null
```

Check these claims:

| Claim | Must be | If not |
| --- | --- | --- |
| three dot-separated parts | a JWT | The token is opaque: set **Token Type** to `JwtRS256` (Option A) |
| `iss` | exactly the `issuer` from step 1 | You read the wrong discovery document |
| `aud` | the Audience you set (A) or the Client ID (B) | Use whatever is there as `OAUTH_AUDIENCE` |
| `exp` | present | The server rejects tokens without an expiry |
| `sub` | the signed-in user | Used in the MCP server's audit log |

The `aud` value is your `OAUTH_AUDIENCE`. If it equals `MCP_PUBLIC_URL` you can leave `OAUTH_AUDIENCE` unset.

Also look for a `scope` or `scp` claim. If there is none, leave `OAUTH_REQUIRED_SCOPES` and `OAUTH_SCOPES_*` unset: the server would refuse every request for a scope the token never carries.

## Part 4: Configure and start the server

Create `.env` from [.env.example](../.env.example):

```bash
# Upstream: the service user from Part 1
IDIRA_SUBDOMAIN=acme
IDIRA_IDENTITY_URL=https://abc1234.id.cyberark.cloud
IDIRA_CLIENT_ID=svc-disco-mcp@cyberark.cloud.1234
IDIRA_CLIENT_SECRET=<service user password>

# This server
MCP_PUBLIC_URL=https://disco-mcp.example.com/mcp
MCP_HOST=0.0.0.0
MCP_PORT=3000

# Inbound: the authorization app from Part 2, values from Part 3
OAUTH_ISSUER_URL=https://abc1234.id.cyberark.cloud/discomcp/
OAUTH_AUDIENCE=https://disco-mcp.example.com/mcp
```

Start it behind your TLS-terminating proxy:

```bash
npm ci && npm run build && npm start
```

On a good start the log shows `oauth enabled` with the issuer, audiences and JWKS URL it discovered, then `listening`. Confirm from outside:

```bash
curl -s https://disco-mcp.example.com/.well-known/oauth-protected-resource/mcp
```

The answer must list your issuer under `authorization_servers` and your public URL as `resource`.

## Part 5: Connect Claude Code

### Through the Idira Agent Identity Broker

1. **Register the MCP server.** Go to **Manage > Inventory > AI > MCP servers**, click **Register custom MCP server**, enter `https://disco-mcp.example.com/mcp` and click **Discover**. Idira should detect **OAuth 2.1**.
2. Choose **Keep the MCP server's OAuth app in Idira**. Idira Identity is not known to offer dynamic client registration, so expect the manual path: copy the **Redirect URL** Idira shows, add it to the app's **Allowed Redirects** (Option A) or **Authorized Redirect URIs** (Option B), then enter the OAuth client's **Client ID** and **Client Secret** from Part 2.
3. Name the server, pick a category and owners, and click **Register**. Enable the server if it is not enabled. The connection mode cannot be changed later; to change it, delete and register again.
4. **Register the agent.** Go to **Manage > Inventory > AI > Managed AI agents**, click **Register AI agent**, choose the Claude agent type and save the credentials shown; they are displayed once.
5. On the MCP server, click **More options > Connect AI agent**, select the agent, and copy the Identity Broker URL and Client ID.
6. Add it to Claude Code:

   ```bash
   claude mcp add --transport http idira-disco https://<tenant-gateway-host>/mcp/<serverName> --client-id <agent-client-id> --client-secret
   ```

7. In Claude Code run `/mcp`, select `idira-disco` and authenticate. Then ask: *"Use disco_query_secrets to count the secrets in the inventory."*

Source: [Register MCP servers](https://docs.cyberark.com/manage/latest/en/content/secureai/register%20mcp%20server.htm), [Secure AI agents access](https://docs.cyberark.com/manage/latest/en/content/secureai/registeragent.htm), [Connect MCP servers to AI agents](https://docs.cyberark.com/manage/latest/en/content/secureai/connect%20mcp%20servers%20to%20agents.htm).

### Directly, to test the server without the broker

This proves Parts 1 to 4 on their own, which makes broker problems much easier to isolate.

1. Add `http://localhost:8765/callback` to the app's allowed redirects.
2. Add the server with the OAuth client from Part 2 and a fixed callback port:

   ```bash
   claude mcp add --transport http idira-disco-direct https://disco-mcp.example.com/mcp --client-id <oauth-client-id> --client-secret --callback-port 8765
   ```

3. Run `/mcp` in Claude Code, authenticate in the browser with an Idira Identity user who is in a role on the app's **Permissions** page, and call a query tool.

Remove this entry once the broker path works, so agents cannot bypass the broker's policy and audit.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Server exits with `Could not load authorization server metadata` | `OAUTH_ISSUER_URL` is not the app's issuer, or the app has no discovery document | Repeat Part 3 step 1; the message lists every URL that was tried |
| Server exits with `names issuer "X", expected "Y"` | `OAUTH_ISSUER_URL` is the tenant URL or has the wrong Application ID | Set it to `X` if `X` is your app's issuer |
| Server exits with `does not advertise a jwks_uri` | The discovery document has no `jwks_uri` | Set `OAUTH_JWKS_URI` to the app's keys URL |
| `401` with `The access token is not a valid JWT` | Opaque token | Option A: **Token Type** `JwtRS256` |
| `401` with `The access token aud claim is not acceptable` | Audience mismatch | Decode a token and set `OAUTH_AUDIENCE` to its `aud` |
| `401` with `The access token iss claim is not acceptable` | Token came from a different app or the tenant-level endpoints | The client must use the app's own endpoints from Part 3 |
| `401` with `The access token signature could not be verified` | Wrong keys URL, or keys rotated moments ago | Check `jwks_uri`; retry after a minute |
| `403` with `insufficient_scope` | A required scope is not in the token | Unset the `OAUTH_*SCOPES*` variables or add the scope to the app |
| `invalid_client` from Idira Identity during sign-in | Client ID Type does not match the client, or the client's domain is not trusted for API calls | Check **Client ID Type**; under **Settings > Authentication > Security Settings > API Security** add the client's domain *(to confirm)* |
| HTTP 400 from Idira Identity during sign-in | Redirect URI not on the allow-list | Add the exact redirect URL; wildcards are not supported |
| Sign-in succeeds but no token is issued | The user is not in a role on the app's **Permissions** page | Add the role |
| Tool error `Idira platform token request failed with HTTP 401` | Wrong service user credentials, or the user is not an OAuth confidential client | Recheck Part 1 |
| Tool error mentioning the **Machines Admin** role | The service user lacks the role | Add it to Machines Admin |
| Broker **Discover** does not detect OAuth 2.1 | The broker cannot reach the public URL or its metadata | Run the `curl` from Part 4 from outside your network |

The reason a token was refused is in the `error_description` of the `WWW-Authenticate` header on the `401` or `403` response; `curl -i` shows it. The server never logs tokens or tool arguments.

## What is confirmed and what is not

| Statement | Basis |
| --- | --- |
| Service user, Machines Admin role, platform token endpoint | Official docs |
| OAuth2 Server app fields: Application ID, Client ID Type, Issuer, Audience, Allowed Redirects, Token Type, Permissions | Official docs |
| Broker registration, connection modes, agent registration | Official docs |
| This server discovers an issuer with an app path and trailing slash, and accepts a non-URL audience | Automated test in this repository |
| App-specific discovery URL, issuer format, endpoint paths, OIDC app audience | Community guide for another MCP server; not in the official docs I found |
| A service user acts as the confidential OAuth client for an OAuth2 Server app | Community guide and inference; confirm in your tenant |
| The broker's Discover step and manual client registration against this server | Not yet run |
| Claude Code's loopback redirect being accepted for the predefined Claude agent type | Not yet run; the docs say custom redirect URLs must be HTTPS |

If a step here turns out wrong for your tenant, the troubleshooting table and Part 3 should still get you to working values. Please open an issue so the guide can be corrected.
