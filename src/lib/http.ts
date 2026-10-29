// HTTP transport that works under both Node's undici and Bun's built-in fetch.
//
// Bun replaces the undici module with its own implementation, where
// `dispatcher.close()` and `body.dump()` do not exist. The exporter must behave
// identically in a terminal (Node) and inside a compiled desktop build (Bun),
// so every request goes through this shim instead of calling undici directly.

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout: number;
  maxRedirections?: number;
  signal?: AbortSignal;
  /**
   * Follow redirects automatically. Callers that need the Location header
   * (resolving a share link, for example) must pass false: fetch follows
   * redirects by default, which would hide the 3xx they are looking for.
   */
  followRedirects?: boolean;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** Read the body as text; on non-2xx the caller decides what to keep. */
  text(): Promise<string>;
  /** Read the body as JSON, throwing on malformed input. */
  json<T = unknown>(): Promise<T>;
  /** Read a binary body as a stream for saving to disk. */
  stream(): AsyncIterable<Uint8Array>;
  /** Abandon the body and release the underlying connection. */
  cancel(): Promise<void>;
}

export interface HttpTransport {
  request(url: URL, options: HttpRequestOptions): Promise<HttpResponse>;
  close(): Promise<void>;
}

function normalizeHeaders(raw: unknown): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  if (!raw) return out;
  // Both fetch Headers and undici's plain object expose entries().
  if (typeof (raw as Headers).forEach === 'function' && !Array.isArray(raw)) {
    (raw as Headers).forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
  }
  for (const [ key, value ] of Object.entries(raw as Record<string, unknown>)) {
    out[key.toLowerCase()] = value as string | string[];
  }
  return out;
}

/** Chooses the native fetch implementation, available in Node 18+ and Bun. */
export function createTransport(): HttpTransport {
  return {
    async request(url, options) {
      const controller = new AbortController();
      // Kept alive past the headers so a body that never ends still aborts.
      const timer = setTimeout(() => controller.abort(), options.timeout);
      // Compose the caller's abort with the timeout so either cancels the request.
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          redirect: options.followRedirects === false ? 'manual' : 'follow',
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        throw error;
      }

      const textBody = () => response.text();
      const jsonBody = async <T, >() => JSON.parse(await textBody()) as T;
      const streamBody = async function* () {
        if (!response.body) return;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      };

      return {
        statusCode: response.status,
        headers: normalizeHeaders(response.headers),
        text: textBody,
        json: jsonBody,
        stream: streamBody,
        // Cancelling tears the connection down; without it a half-read body keeps
        // the socket (and the process) alive.
        cancel: async () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          // A body that is already gone is a no-op, not a failure.
          await response.body?.cancel().catch(() => undefined);
        },
      };
    },
    async close() {
      // Nothing to release: fetch pools connections internally.
    },
  };
}

/**
 * Reads and discards a body so the connection can be reused, bounded by a byte
 * limit. An error response may stream forever; draining it without a cap would
 * hang the request instead of reporting the status code we already have.
 */
export async function drain(response: HttpResponse, limit = 64 * 1024): Promise<void> {
  let seen = 0;
  try {
    for await (const chunk of response.stream()) {
      seen += chunk.byteLength;
      if (seen >= limit) {
        // Too much to bother reading: drop the connection instead of waiting for
        // an end that may never come.
        await response.cancel();
        return;
      }
    }
  } catch {
    // A body that fails mid-stream is not an error when we only wanted to discard it.
  }
}
