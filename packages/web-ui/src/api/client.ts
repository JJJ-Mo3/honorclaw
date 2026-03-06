/**
 * Central API client for the HonorClaw Web UI.
 *
 * - Base URL derived from VITE_API_URL env or window.location.origin
 * - credentials: "include" on all requests (cookie-based auth)
 * - 401 → redirect to /login
 * - 403 → throw PermissionDeniedError
 * - Response bodies are never logged
 */

export class PermissionDeniedError extends Error {
  constructor(message = 'You do not have permission to perform this action') {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function getBaseUrl(): string {
  const meta = import.meta;
  if (meta && (meta as unknown as Record<string, unknown>)['env']) {
    const env = (meta as unknown as { env: Record<string, string> }).env;
    if (env['VITE_API_URL']) {
      return env['VITE_API_URL'];
    }
  }

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  return 'http://localhost:3000';
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    // Redirect to login — session has expired or user is not authenticated
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Authentication required');
  }

  if (response.status === 403) {
    throw new PermissionDeniedError();
  }

  if (!response.ok) {
    // Parse error message from response body if possible, but never log it
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      if (body.error) message = body.error;
      else if (body.message) message = body.message;
    } catch {
      // Body not JSON — use default message
    }
    throw new ApiError(response.status, message);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`/api${path}`, getBaseUrl());
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    return handleResponse<T>(response);
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(`/api${path}`, getBaseUrl());

    const response = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    return handleResponse<T>(response);
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(`/api${path}`, getBaseUrl());

    const response = await fetch(url.toString(), {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    return handleResponse<T>(response);
  },

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(`/api${path}`, getBaseUrl());

    const response = await fetch(url.toString(), {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    return handleResponse<T>(response);
  },

  async delete<T>(path: string): Promise<T> {
    const url = new URL(`/api${path}`, getBaseUrl());

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });

    return handleResponse<T>(response);
  },

  /**
   * Download a file as a Blob (for exports).
   */
  async download(path: string, params?: Record<string, string>): Promise<Blob> {
    const url = new URL(`/api${path}`, getBaseUrl());
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
    });

    if (response.status === 401) {
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      throw new ApiError(401, 'Authentication required');
    }

    if (response.status === 403) {
      throw new PermissionDeniedError();
    }

    if (!response.ok) {
      throw new ApiError(response.status, `Download failed with status ${response.status}`);
    }

    return response.blob();
  },
};
