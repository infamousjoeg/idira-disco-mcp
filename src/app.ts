import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildOAuthProtectedResourceMetadata, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';

import { createJwtVerifier, discoverAuthorizationServer } from './auth.js';
import type { Config } from './config.js';
import { DiscoClient } from './disco/client.js';
import type { Logger } from './logger.js';
import { createDiscoServer, SERVER_NAME } from './server.js';

/** Tool calls carry up to 500 entities with free-form metadata, well past Express's 100kb default. */
const JSON_BODY_LIMIT = '4mb';

export interface AppDeps {
  logger: Logger;
  /** Used for the upstream Idira calls and for authorization server discovery. */
  fetch?: typeof fetch;
}

export interface BuiltApp {
  app: Express;
  handler: McpHttpHandler;
}

export async function buildApp(config: Config, deps: AppDeps): Promise<BuiltApp> {
  const { logger } = deps;
  const client = new DiscoClient({ ...config.idira, fetch: deps.fetch });
  const handler = createMcpHandler(() => createDiscoServer({ client, config, logger }), {
    onerror: (error) => logger.warn('mcp handler error', { error: error.message }),
  });

  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts, jsonLimit: JSON_BODY_LIMIT });
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', server: SERVER_NAME });
  });

  const gates: RequestHandler[] = [];
  if (config.auth) {
    const { auth } = config;
    const oauthMetadata = await discoverAuthorizationServer(auth.issuerUrl, deps.fetch);
    const advertised: unknown = oauthMetadata.jwks_uri;
    const jwksUri = auth.jwksUri ?? (typeof advertised === 'string' ? advertised : undefined);
    if (!jwksUri) {
      throw new Error(`Authorization server ${auth.issuerUrl} does not advertise a jwks_uri; set OAUTH_JWKS_URI`);
    }
    const scopesSupported = [
      ...new Set([...auth.requiredScopes, ...auth.scopes.read, ...auth.scopes.write, ...auth.scopes.delete]),
    ];
    const metadataOptions = {
      oauthMetadata,
      resourceServerUrl: config.publicUrl,
      resourceName: 'Idira Discovery & Context MCP server',
      ...(scopesSupported.length > 0 && { scopesSupported }),
    };
    app.use(mcpAuthMetadataRouter(metadataOptions));
    if (config.mcpPath !== '/') {
      // Clients that do not follow the 401 challenge fall back to the root well-known location.
      const protectedResourceMetadata = buildOAuthProtectedResourceMetadata(metadataOptions);
      app.get('/.well-known/oauth-protected-resource', (_req, res) => {
        res.set('Access-Control-Allow-Origin', '*').json(protectedResourceMetadata);
      });
    }
    gates.push(
      requireBearerAuth({
        verifier: createJwtVerifier({
          issuer: oauthMetadata.issuer,
          audiences: auth.audiences,
          resource: config.publicUrl,
          jwksUri,
        }),
        requiredScopes: auth.requiredScopes,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.publicUrl),
        expectedResource: config.publicUrl,
      }),
    );
    logger.info('oauth enabled', { issuer: oauthMetadata.issuer, audiences: auth.audiences, jwksUri });
  } else {
    logger.warn('authentication is DISABLED; serving on loopback only');
  }

  const serve = toNodeHandler(handler, { onerror: (error) => logger.error('request failed', { error: error.message }) });
  app.all(config.mcpPath, ...gates, (req, res) => serve(req, res, req.body));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  // Replaces Express's default error page, which would expose stack traces and file paths.
  const onError: ErrorRequestHandler = (error: { status?: number; message?: string }, _req, res, _next) => {
    const status = typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) logger.error('unhandled request error', { error: error.message });
    const message =
      status === 400 ? 'Parse error: the request body is not valid JSON' : status === 413 ? 'Request body too large' : status === 500 ? 'Internal server error' : 'Bad request';
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32600, message }, id: null });
  };
  app.use(onError);

  return { app, handler };
}
