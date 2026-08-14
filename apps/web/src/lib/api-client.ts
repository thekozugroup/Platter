import {
  API_PREFIX,
  ERROR_MESSAGES,
  isApiErrorBody,
  type ErrorCode,
  type AuthResponse,
} from '@platter/shared';

/**
 * The single HTTP path to the API.
 *
 * Three things live here that are easy to get subtly wrong if every call site does its
 * own fetch: the access token never touching storage, refresh being single-flight, and
 * every failure arriving as a typed `ApiError` rather than a raw Response.
 */

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, string[]>;
  readonly requestId?: string;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number;
    details?: Record<string, string[]>;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    if (init.details) this.details = init.details;
    if (init.requestId) this.requestId = init.requestId;
  }

  /** Field errors keyed by form field name, ready to hand to a form. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, messages] of Object.entries(this.details ?? {})) {
      const first = messages[0];
      if (first) out[path] = first;
    }
    return out;
  }

  /** Whether retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.status >= 500 ||
      this.code === 'rate_limited' ||
      this.code === 'node_unreachable' ||
      this.code === 'service_unavailable'
    );
  }
}

/** A failure before we ever reached the API — offline, DNS, connection reset. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("Can't reach the server. Check your connection.");
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

type Listener = (token: string | null) => void;

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the refresh-and-retry dance — used by the refresh call itself. */
  skipAuthRetry?: boolean;
  /**
   * Non-2xx statuses that are *outcomes*, not failures — their body is parsed and returned
   * like a 200 instead of being thrown away as an error.
   *
   * Two routes need this today and both designed it deliberately.
   * `POST /servers/:id/proposals/:id/approve` answers 409 with the full `ApprovalOutcome`
   * — the diff, the new digest, the reason it was blocked. That body *is* the feature: it
   * is what the reviewer reads before approving again. `GET /system/ready` answers 503
   * carrying the per-check breakdown that says which dependency is down.
   *
   * Throwing those away leaves the UI unable to say anything more useful than "conflict",
   * and in the proposal case leaves a drifted proposal permanently unapprovable.
   *
   * The caller's `T` must cover every listed status; switch on a discriminant in the body,
   * not on the HTTP code, which is not returned here.
   */
  expect?: readonly number[];
}

class ApiClient {
  /**
   * Held in memory only. A token in localStorage is readable by any script that gets
   * injected into the page; the refresh token lives in an httpOnly cookie the JS cannot
   * touch, and a page reload re-mints the access token from it.
   */
  #accessToken: string | null = null;
  #refreshInFlight: Promise<string | null> | null = null;
  #listeners = new Set<Listener>();

  get accessToken(): string | null {
    return this.#accessToken;
  }

  setAccessToken(token: string | null): void {
    this.#accessToken = token;
    for (const listener of this.#listeners) listener(token);
  }

  /** Notifies the auth store when a token is set or cleared (including on forced logout). */
  onTokenChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { body, query, skipAuthRetry, expect, headers, ...rest } = options;
    const url = buildUrl(path, query);

    const requestHeaders = new Headers(headers);
    requestHeaders.set('accept', 'application/json');
    if (this.#accessToken) requestHeaders.set('authorization', `Bearer ${this.#accessToken}`);

    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      // Let the browser set the multipart boundary — setting it by hand corrupts the body.
      payload = body;
    } else if (body !== undefined) {
      requestHeaders.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        method,
        headers: requestHeaders,
        body: payload,
        // Sends the refresh cookie; also required for the login/refresh Set-Cookie to stick.
        credentials: 'include',
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new NetworkError(cause);
    }

    if (response.status === 401 && !skipAuthRetry) {
      const refreshed = await this.#refresh();
      if (refreshed) {
        return this.request<T>(method, path, { ...options, skipAuthRetry: true });
      }
    }

    // 401 is never "expected": it means the session is gone, and the refresh above already
    // had its chance. Letting a caller opt out of that would hide a forced logout.
    const expected = response.status !== 401 && (expect?.includes(response.status) ?? false);
    if (!response.ok && !expected) throw await toApiError(response);
    if (response.status === 204) return undefined as T;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return (await response.text()) as T;
    return (await response.json()) as T;
  }

  /**
   * Refresh, at most once concurrently. Without this guard, a page that fires six queries
   * on mount would send six refreshes; with rotating refresh tokens, five of those are
   * replays of a spent token and would log the user out.
   */
  async #refresh(): Promise<string | null> {
    this.#refreshInFlight ??= (async () => {
      try {
        const result = await this.request<AuthResponse>('POST', '/auth/refresh', {
          skipAuthRetry: true,
        });
        this.setAccessToken(result.accessToken);
        return result.accessToken;
      } catch (error) {
        /*
         * Only an *auth* failure ends the session. A refresh can also fail because the API
         * is rate-limiting (`/auth/login` and `/auth/refresh` share one ten-per-minute
         * budget), because it restarted, or because the laptop's network dropped — and
         * signing someone out over a transient 429 discards a session that is still
         * perfectly valid. Those cases leave the current token alone and let the original
         * request surface its own error, which is the one worth reading.
         */
        if (error instanceof ApiError && !error.retryable) this.setAccessToken(null);
        return null;
      } finally {
        // Cleared in a microtask so callers awaiting this promise all see the same result.
        queueMicrotask(() => {
          this.#refreshInFlight = null;
        });
      }
    })();

    return this.#refreshInFlight;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('POST', path, { ...options, body });
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PATCH', path, { ...options, body });
  }
  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PUT', path, { ...options, body });
  }
  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, options);
  }

  /** Absolute URL for links the browser fetches directly (downloads, exports). */
  url(path: string, query?: RequestOptions['query']): string {
    return buildUrl(path, query);
  }

  /**
   * Server-sent events, used for streaming AI replies. `EventSource` cannot send an
   * Authorization header, so this reads the fetch body stream directly instead.
   */
  async *stream(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    if (this.#accessToken) headers.set('authorization', `Bearer ${this.#accessToken}`);

    let response: Response;
    try {
      response = await fetch(buildUrl(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      throw new NetworkError(cause);
    }

    if (!response.ok) throw await toApiError(response);
    if (!response.body) return;

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;

        // SSE events are separated by a blank line; a chunk can split one in half.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = rawEvent
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data && data !== '[DONE]') yield data;
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = path.startsWith('/api') ? path : `${API_PREFIX}${path}`;
  if (!query) return base;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `${base}?${serialised}` : base;
}

async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (isApiErrorBody(parsed)) {
    return new ApiError({
      code: parsed.error.code,
      message: parsed.error.message,
      status: response.status,
      ...(parsed.error.details ? { details: parsed.error.details } : {}),
      ...((parsed.error.requestId ?? requestId)
        ? { requestId: parsed.error.requestId ?? requestId }
        : {}),
    });
  }

  // A non-envelope error means something in front of the API answered — a proxy, a
  // gateway, a 502 HTML page. Fall back to a code inferred from the status.
  const code = statusToCode(response.status);
  return new ApiError({
    code,
    message: ERROR_MESSAGES[code],
    status: response.status,
    ...(requestId ? { requestId } : {}),
  });
}

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 422:
      return 'validation_failed';
    case 429:
      return 'rate_limited';
    case 503:
      return 'service_unavailable';
    default:
      return status >= 500 ? 'internal_error' : 'bad_request';
  }
}

/** Human-facing copy for any thrown value, so no screen has to hand-roll this. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || ERROR_MESSAGES[error.code];
  if (error instanceof NetworkError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return ERROR_MESSAGES.internal_error;
}

export const api = new ApiClient();
