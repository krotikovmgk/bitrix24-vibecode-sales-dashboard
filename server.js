'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { FilterValidationError, parseFilters, summarizeDashboard } = require('./lib/dashboard');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VIBE_BASE_URL = process.env.VIBE_BASE_URL || 'https://vibecode.bitrix24.tech';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEALS_LIMIT = 5000;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const SESSION_CACHE_LIMIT = 1000;
const sessionCache = new Map();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

class UpstreamError extends Error {
  constructor(status, code, message) {
    super(message || 'VibeCode API request failed');
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code || 'UPSTREAM_ERROR';
  }
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.eu https://*.bitrix24.de https://*.bitrix24.com.br https://*.bitrix24.in https://*.bitrix24.kz https://*.bitrix24.by",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join('; '),
  };
}

function json(res, status, payload) {
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function currentUserFromHeaders(req) {
  const id = Number(req.headers['x-vibe-user-id'] || 0);
  const encodedName = req.headers['x-vibe-user-name-encoded'];
  let name = String(req.headers['x-vibe-user-name'] || 'Пользователь Битрикс24');

  if (encodedName) {
    try {
      name = decodeURIComponent(String(encodedName));
    } catch {
      // Keep the non-encoded fallback header when the encoded value is malformed.
    }
  }

  return {
    id: Number.isFinite(id) ? id : 0,
    name,
    role: String(req.headers['x-vibe-user-role'] || 'MEMBER').toLowerCase(),
  };
}

function pruneSessionCache(now = Date.now()) {
  for (const [sessionId, context] of sessionCache) {
    if (context.expiresAt <= now) sessionCache.delete(sessionId);
  }

  while (sessionCache.size > SESSION_CACHE_LIMIT) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
}

function requestContext(req) {
  const now = Date.now();
  pruneSessionCache(now);

  const existingId = String(req.headers['x-dashboard-session'] || '');
  const existing = existingId ? sessionCache.get(existingId) : null;
  if (existing && existing.expiresAt > now) {
    existing.expiresAt = now + SESSION_TTL_MS;
    return { ...existing, sessionId: existingId };
  }

  const authorization = String(req.headers['x-vibe-authorization'] || '');
  if (!authorization.startsWith('Bearer ')) {
    throw new UpstreamError(401, 'SESSION_MISSING', 'Откройте приложение внутри Битрикс24.');
  }

  const sessionId = crypto.randomUUID();
  const context = {
    authorization,
    currentUser: currentUserFromHeaders(req),
    expiresAt: now + SESSION_TTL_MS,
  };
  sessionCache.set(sessionId, context);
  pruneSessionCache(now);
  return { ...context, sessionId };
}

async function vibeRequest(apiPath, context, options = {}) {
  const appKey = process.env.VIBE_APP_KEY;
  if (!appKey) {
    throw new UpstreamError(503, 'APP_NOT_CONFIGURED', 'Сервер приложения не настроен.');
  }

  const response = await fetch(`${VIBE_BASE_URL}${apiPath}`, {
    method: options.method || 'GET',
    headers: {
      'X-Api-Key': appKey,
      Authorization: context.authorization,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new UpstreamError(
      response.status,
      payload.error?.code || 'UPSTREAM_ERROR',
      payload.error?.userMessage || payload.error?.message,
    );
  }
  return payload;
}

async function loadDashboard(req, url) {
  const context = requestContext(req);
  const filters = parseFilters(url.searchParams);
  const stageEntityId = filters.categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${filters.categoryId}`;
  const dealFilter = {
    categoryId: filters.categoryId,
    '>=createdAt': filters.createdFrom,
    '<createdAt': filters.createdBefore,
    ...(filters.responsible === 'me' ? { assignedById: context.currentUser.id } : {}),
  };
  const batch = await vibeRequest('/v1/batch', context, {
    method: 'POST',
    body: {
      calls: [
        {
          id: 'categories',
          entity: 'deal-categories',
          action: 'list',
          params: { limit: 50 },
        },
        {
          id: 'statuses',
          entity: 'statuses',
          action: 'list',
          params: {
            filter: { entityId: stageEntityId },
            limit: 50,
          },
        },
        {
          id: 'deals',
          entity: 'deals',
          action: 'search',
          params: {
            filter: dealFilter,
            select: [
              'id',
              'title',
              'amount',
              'currency',
              'stageId',
              'categoryId',
              'assignedById',
              'createdAt',
            ],
            // Entity API auto-pagination supports ordering by ID here. The
            // final latest-deals ordering is still based on createdAt below.
            order: { id: 'DESC' },
            limit: DEALS_LIMIT,
          },
        },
        {
          id: 'users',
          entity: 'users',
          action: 'list',
          params: {
            select: ['id', 'name', 'lastName', 'active'],
            filter: { active: true },
            limit: 5000,
          },
        },
      ],
    },
  });

  const data = batch.data || {};
  const errors = data.errors || {};
  for (const required of ['categories', 'statuses', 'deals']) {
    if (errors[required] || !Object.hasOwn(data.results || {}, required)) {
      const problem = errors[required] || {};
      throw new UpstreamError(502, problem.code || 'DASHBOARD_DATA_UNAVAILABLE', problem.message);
    }
  }

  const dashboard = summarizeDashboard({
    categories: data.results.categories,
    statuses: data.results.statuses,
    deals: data.results.deals,
    users: data.results.users || [],
    filters,
    currentUser: context.currentUser,
    dealsLimit: DEALS_LIMIT,
    truncated: data.meta?.deals?.truncated || data.meta?.deals?.hasMore,
  });
  return { dashboard, sessionId: context.sessionId };
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const decoded = decodeURIComponent(requested);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Страница не найдена.' } });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...securityHeaders(MIME_TYPES[extension] || 'application/octet-stream'),
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Страница не найдена.' } });
      return;
    }
    throw error;
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const requestId = String(req.headers['x-vibe-request-id'] || crypto.randomUUID());
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
        json(res, 200, { success: true, service: 'sales-funnel-dashboard' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const { dashboard, sessionId } = await loadDashboard(req, url);
        json(res, 200, { success: true, data: dashboard, sessionId });
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается.' } });
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      const isFilterError = error instanceof FilterValidationError;
      const isUpstreamError = error instanceof UpstreamError;
      const status = isFilterError ? 400 : isUpstreamError ? Math.min(Math.max(error.status, 400), 599) : 500;
      const code = isFilterError ? 'INVALID_FILTER' : isUpstreamError ? error.code : 'INTERNAL_ERROR';
      const message = isFilterError || isUpstreamError
        ? error.message
        : 'Не удалось сформировать дашборд. Повторите попытку.';
      console.error(JSON.stringify({ requestId, status, code }));
      json(res, status, { success: false, error: { code, message, requestId } });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`sales-funnel-dashboard listening on ${HOST}:${PORT}`);
  });
}

module.exports = { createServer, loadDashboard };
