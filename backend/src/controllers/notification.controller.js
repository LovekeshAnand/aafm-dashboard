import { z } from "zod";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Features F3 + F4: the signed-in user's own notifications (RLS: notifications_own_*).
// Available before a team is selected, so someone removed from their only team still sees why.
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const readSchema = z.strictObject({
  ids: z.array(z.uuid()).max(100).optional(), // omitted = mark all as read
});

const listNotifications = asyncHandler(async (req, res) => {
  const { limit } = listSchema.parse(req.query);
  const { items, unread } = await req.db(async (db) => {
    const { rows } = await db.query(
      `SELECT id, kind, title, body, link, meta, read_at, created_at
       FROM notifications ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    const {
      rows: [count],
    } = await db.query(
      "SELECT count(*)::int AS unread FROM notifications WHERE read_at IS NULL"
    );
    return { items: rows, unread: count.unread };
  });
  res.json(new ApiResponse(200, { items, unread }));
});

const markRead = asyncHandler(async (req, res) => {
  const { ids } = readSchema.parse(req.body ?? {});
  const { rowCount } = await req.db((db) =>
    db.query(
      `UPDATE notifications SET read_at = now()
       WHERE read_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY ($1))`,
      [ids ?? null]
    )
  );
  res.json(new ApiResponse(200, { marked: rowCount }, "Marked as read"));
});

export { listNotifications, markRead };
