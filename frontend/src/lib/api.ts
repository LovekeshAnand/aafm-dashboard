import { currentSocketId, resetSocket } from "./realtime";

// Thin client for the Express API (proxied same-origin under /api, so the session cookie is
// first-party). Every write carries X-Requested-With, which the backend's CSRF guard requires.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: { field?: string; message: string }[] = []
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Window event fired when an API call finds the session gone (handled in session.tsx). */
export const SESSION_EXPIRED = "aafm:session-expired";

// E10 (docs/edge-case-audit.md): never wait forever on a hung server.
const TIMEOUT_MS = 15_000;

const send = (
  path: string,
  method: Method,
  body: unknown,
  idempotencyKey?: string
) =>
  fetch(`/api/v1${path}`, {
    method,
    headers: {
      "X-Requested-With": "fetch",
      // Lets the server skip echoing this change back to the tab that made it.
      ...(currentSocketId() && { "X-Socket-Id": currentSocketId() }),
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

export async function api<T>(
  path: string,
  method: Method = "GET",
  body?: unknown
): Promise<T> {
  // E20: a create carries an Idempotency-Key, so if the network fails or the request times
  // out, it is safely sent once more with the same key: the server returns the first result
  // instead of creating a duplicate.
  const key =
    method === "POST" && !path.startsWith("/auth/")
      ? crypto.randomUUID()
      : undefined;
  let res: Response;
  try {
    res = await send(path, method, body, key).catch((err) => {
      if (!key) throw err;
      return send(path, method, body, key);
    });
  } catch (err) {
    throw new ApiError(
      0,
      err instanceof DOMException && err.name === "TimeoutError"
        ? "The server didn't respond in time. Try again."
        : "Can't reach the server. Check your connection and try again."
    );
  }
  const json = await res.json().catch(() => ({ message: res.statusText }));
  // The socket authenticated with the old session; reconnect with the new one.
  if (path.startsWith("/auth/") && method !== "GET") resetSocket();
  // E13: the session ended (idle timeout, signed out elsewhere, revoked). The session
  // provider sends the user to sign-in and back here. /auth/* calls handle 401 themselves.
  if (res.status === 401 && !path.startsWith("/auth/"))
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  if (!res.ok)
    throw new ApiError(
      res.status,
      json.message ?? "Request failed",
      json.errors
    );
  return json.data as T;
}

/** First validation message if there is one, else the error message. */
export const errorText = (err: unknown) =>
  err instanceof ApiError
    ? err.errors[0]
      ? `${err.errors[0].field ? `${err.errors[0].field}: ` : ""}${err.errors[0].message}`
      : err.message
    : "Something went wrong";
