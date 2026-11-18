import { publishUserEvent } from "../realtime.js";

// Features F3 + F4 (Prompt 68): in-app notifications. `notify` writes the row inside the
// caller's transaction (so it exists only if the change committed); `deliver` pushes the
// committed rows to each recipient's open tabs.
const ROLE_NAME = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

const notify = async (
  db,
  userId,
  kind,
  title,
  { body = "", link = null, meta = {} } = {}
) => {
  const {
    rows: [row],
  } = await db.query("SELECT * FROM app.notify($1, $2, $3, $4, $5, $6)", [
    userId,
    kind,
    title,
    body,
    link,
    meta,
  ]);
  return row;
};

/** After commit: push each notification to its recipient's sockets (all their tabs). */
const deliver = (notifications) => {
  for (const n of notifications.filter(Boolean))
    publishUserEvent(n.user_id, "notifications:new", n);
};

/** A team's display name, read under the caller's RLS. */
const teamName = async (db, teamId) =>
  (await db.query("SELECT name FROM teams WHERE id = $1", [teamId])).rows[0]
    ?.name ?? "a team";

export { deliver, notify, ROLE_NAME, teamName };
