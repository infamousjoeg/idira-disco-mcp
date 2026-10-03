/**
 * Local sandbox: starts a mock Idira tenant and a mock OAuth authorization server, runs the
 * built MCP server against them, and writes an MCP client config with a valid bearer token.
 * Nothing leaves this machine. Usage: npm run demo [-- --ttl <seconds>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { startMockAuthorizationServer } from '../test/helpers/mockAs.js';
import { startMockIdira } from '../test/helpers/mockIdira.js';

const port = Number(process.env.MCP_PORT ?? 3000);
const ttlIndex = process.argv.indexOf('--ttl');
const ttlSeconds = ttlIndex === -1 ? undefined : Number(process.argv[ttlIndex + 1]);
const url = `http://localhost:${port}/mcp`;

if (!existsSync('dist/index.js')) {
  console.error('dist/index.js not found. Run "npm run build" first (or use "npm run demo").');
  process.exit(1);
}

const idira = await startMockIdira();
const as = await startMockAuthorizationServer();

idira.seed('secrets', [
  { originId: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:payments/api-key', name: 'payments/api-key', providerId: '111122223333', providerType: 'aws', type: 'Secret', location: 'us-east-1', dataSourceType: 'AWS_SCANNER' },
  { originId: '/subscriptions/0000/vaults/kv-prod/secrets/sql-admin', name: 'sql-admin', providerId: '0000', providerType: 'azure', type: 'Secret', location: 'eastus', dataSourceType: 'AZURE_SCANNER' },
]);
idira.seed('workloads', [
  { originId: 'k8s://prod-cluster/payments/deploy/api', name: 'payments-api', providerId: 'prod-cluster', providerType: 'kubernetes', type: 'container', location: 'payments', dataSourceType: 'KUBERNETES_DISCOVERY_AGENT' },
]);

const token = await as.sign({ aud: url, sub: 'demo-user', client_id: 'demo-agent', scope: 'disco' }, { expiresIn: 8 * 3600 });

const server = spawn(process.execPath, ['dist/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MCP_PORT: String(port),
    MCP_PUBLIC_URL: url,
    OAUTH_ISSUER_URL: as.issuer,
    IDIRA_DISCO_GRAPHQL_URL: idira.graphqlUrl,
    IDIRA_PLATFORM_TOKEN_URL: idira.tokenUrl,
    IDIRA_CLIENT_ID: 'svc-disco@example.com',
    IDIRA_CLIENT_SECRET: 's3cret!',
  },
});

mkdirSync('.demo', { recursive: true });
writeFileSync(
  '.demo/mcp.json',
  JSON.stringify({ mcpServers: { 'idira-disco': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
);

console.error(`\nSandbox ready (mock data only).\n  MCP endpoint : ${url}\n  Client config: .demo/mcp.json (bearer token valid for 8 hours)\n`);
console.error('Try: claude --mcp-config .demo/mcp.json --strict-mcp-config\n');

const stop = async (): Promise<void> => {
  server.kill();
  await Promise.all([idira.close(), as.close()]);
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
server.on('exit', (code) => {
  if (code) process.exit(code);
});
if (ttlSeconds) setTimeout(() => void stop(), ttlSeconds * 1000);
