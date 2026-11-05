/**
 * @fileoverview Minimal zero-dependency HTTP server helper for UI sidecars
 * using Node.js standard library (`node:http`) and the raw Sidecar HTTP contract.
 *
 * Contract:
 * - Binds to `127.0.0.1` on `process.env.ANTIGRAVITY_SIDECAR_WEB_PORT`.
 * - Enforces `ANTIGRAVITY_SIDECAR_UI_TOKEN` (via `X-Sidecar-Token` header or
 *   `?token=` query param) on non-GET requests.
 * - Serves HTML/static routes and JSON API routes.
 */

import { createServer } from 'node:http';

const BIND_HOST = '127.0.0.1';

export class HttpResponse {
  constructor(
    body,
    {
      contentType = 'text/plain; charset=utf-8',
      status = 200,
      headers = {},
    } = {}
  ) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

export class RawSidecarServer {
  #port;
  #token;
  #pages = new Map();
  #apis = new Map();
  #server = null;

  constructor() {
    const portStr =
      process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '';
    const parsedPort = Number.parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0) {
      throw new Error(
        'Missing or invalid ANTIGRAVITY_SIDECAR_WEB_PORT environment variable.'
      );
    }
    this.#port = parsedPort;
    this.#token = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim();
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
      conversationId:
        process.env.ANTIGRAVITY_SIDECAR_CONVERSATION_ID ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        '',
    };
  }

  page(routePath, handler) {
    this.#pages.set(routePath, handler);
  }

  api(routePath, handler, method = 'POST') {
    const upper = method.toUpperCase();
    if (!this.#apis.has(routePath)) {
      this.#apis.set(routePath, new Map());
    }
    this.#apis.get(routePath).set(upper, handler);
  }

  #validateToken(req, url) {
    if (!this.#token) return true;
    const provided =
      req.headers['x-sidecar-token'] || url.searchParams.get('token') || '';
    return provided === this.#token;
  }

  #readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  #sendResponse(
    res,
    result,
    defaultContentType = 'application/json; charset=utf-8'
  ) {
    if (
      result instanceof HttpResponse ||
      (result &&
        typeof result === 'object' &&
        result.contentType &&
        result.body !== undefined)
    ) {
      const status = result.status || 200;
      const payload =
        typeof result.body === 'string' || Buffer.isBuffer(result.body)
          ? result.body
          : Buffer.from(result.body);
      res.writeHead(status, {
        'Content-Type': result.contentType,
        ...result.headers,
      });
      res.end(payload);
      return;
    }

    res.writeHead(200, { 'Content-Type': defaultContentType });
    res.end(typeof result === 'string' ? result : JSON.stringify(result));
  }

  run() {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(
          req.url || '/',
          `http://${BIND_HOST}:${this.#port}`
        );

        if (req.method !== 'GET' && !this.#validateToken(req, url)) {
          res.writeHead(401, {
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const content = await this.#pages.get(url.pathname)(url);
          if (content instanceof HttpResponse) {
            this.#sendResponse(res, content);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
          return;
        }

        if (this.#apis.has(url.pathname)) {
          const methodMap = this.#apis.get(url.pathname);
          if (!methodMap.has(req.method)) {
            res.writeHead(405, {
              'Content-Type': 'application/json; charset=utf-8',
            });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const data = {};
          for (const [key, value] of url.searchParams.entries()) {
            if (key.toLowerCase() !== 'token') {
              data[key] = value;
            }
          }

          const rawBody = await this.#readRequestBody(req);
          if (rawBody.trim()) {
            Object.assign(data, JSON.parse(rawBody));
          }

          const handler = methodMap.get(req.method);
          const result = await handler(data, req, url);
          this.#sendResponse(res, result);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
    });

    return new Promise((resolve) => {
      this.#server = server.listen(this.#port, BIND_HOST, () => {
        const addr = server.address();
        const boundPort =
          typeof addr === 'object' && addr ? addr.port : this.#port;
        console.log(`[git_ui] listening on ${BIND_HOST}:${boundPort}`);
        resolve(server);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
  }
}
