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

export async function api<T>(
  path: string,
  method: Method = "GET",
  body?: unknown
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      "X-Requested-With": "fetch",
      // Lets the server skip echoing this change back to the tab that made it.
      ...(currentSocketId() && { "X-Socket-Id": currentSocketId() }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({ message: res.statusText }));
  // The socket authenticated with the old session; reconnect with the new one.
  if (path.startsWith("/auth/") && method !== "GET") resetSocket();
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
