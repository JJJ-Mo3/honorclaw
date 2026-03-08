/**
 * CLI API client for communicating with the HonorClaw Control Plane API.
 *
 * Supports two authentication modes:
 *   1. Device authorization grant (interactive flows via `honorclaw login`)
 *   2. API key (headless / CI environments via HONORCLAW_API_KEY)
 *
 * All errors are caught and re-thrown with user-friendly messages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Configuration ───────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.honorclaw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');

function getBaseUrl(): string {
  return process.env['HONORCLAW_API_URL'] ?? 'http://localhost:3000';
}

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

// ── Token persistence ───────────────────────────────────────────────────

function loadToken(): StoredToken | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = fs.readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(data) as StoredToken;
  } catch {
    return null;
  }
}

function saveToken(token: StoredToken): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export function clearToken(): void {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
  } catch {
    // Best effort
  }
}

// ── Auth helpers ────────────────────────────────────────────────────────

function getAuthHeader(): Record<string, string> {
  // Prefer API key from environment (CI / headless)
  const apiKey = process.env['HONORCLAW_API_KEY'];
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  }

  // Fall back to stored token (interactive)
  const token = loadToken();
  if (token) {
    const expiresAt = new Date(token.expiresAt);
    if (expiresAt > new Date()) {
      return { Authorization: `Bearer ${token.accessToken}` };
    }
    // Token expired — caller should re-authenticate
  }

  return {};
}

// ── Error handling ──────────────────────────────────────────────────────

export class CliApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CliApiError';
    this.status = status;
  }
}

function friendlyError(status: number, body: string): CliApiError {
  if (status === 401) {
    // Check if there's a stored token that may have expired
    const token = loadToken();
    if (token) {
      const expiresAt = new Date(token.expiresAt);
      if (expiresAt <= new Date()) {
        return new CliApiError(status, 'Your session has expired. Run `honorclaw login` to re-authenticate.');
      }
    }
    return new CliApiError(status, 'Authentication required. Run `honorclaw login` first.');
  }

  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    const msg = parsed.error ?? parsed.message ?? `Request failed (HTTP ${status})`;
    return new CliApiError(status, msg);
  } catch {
    // Not JSON
  }

  switch (status) {
    case 403:
      return new CliApiError(status, 'Permission denied. Check your role and workspace.');
    case 404:
      return new CliApiError(status, 'Resource not found.');
    case 409:
      return new CliApiError(status, 'Conflict — the resource already exists or was modified.');
    case 422:
      return new CliApiError(status, 'Validation error. Check your input.');
    case 429:
      return new CliApiError(status, 'Rate limit exceeded. Wait a moment and try again.');
    case 500:
      return new CliApiError(status, 'Internal server error. Check the server logs.');
    default:
      return new CliApiError(status, `Request failed with HTTP ${status}.`);
  }
}

// ── Core request function ───────────────────────────────────────────────

async function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`/api${urlPath}`, getBaseUrl());
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...getAuthHeader(),
  };

  const init: RequestInit = { method, headers };

  if (body != null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliApiError(
      0,
      `Cannot connect to HonorClaw at ${getBaseUrl()}. Is the server running?\n(${msg})`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw friendlyError(response.status, text);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

// ── Public API ──────────────────────────────────────────────────────────

export const cliApi = {
  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return request<T>('GET', path, undefined, params);
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body);
  },

  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body);
  },

  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body);
  },

  delete<T>(path: string): Promise<T> {
    return request<T>('DELETE', path);
  },

  /** Save a token obtained from device authorization or login. */
  saveToken,

  /** Load a stored token (for refresh checks). */
  loadToken,

  /** Clear stored authentication. */
  clearToken,

  /** Get the configured base URL. */
  getBaseUrl,

  /** Get the auth headers for raw fetch requests. */
  getAuthHeaders(): Record<string, string> {
    return getAuthHeader();
  },
};
