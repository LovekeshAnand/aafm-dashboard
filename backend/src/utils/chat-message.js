// Feature F5 (Prompt 68): webhooks for people who aren't developers. Chat apps get one plain
// sentence in their own message format instead of developer JSON.
//   Slack    {"text": ...}                 https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
//   Discord  {"content": ...} (<= 2000)    https://docs.discord.com/developers/resources/webhook
//   Teams    Workflows Adaptive Card       https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
const METRIC = {
  revenue: "Revenue",
  page_views: "Page views",
  clicks: "Clicks",
  errors: "Errors",
  users: "Active users",
};
const ROLE = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
const CHANGE = {
  "dashboard.rename": "renamed it",
  "widget.add": "added a widget",
  "widget.update": "edited a widget",
  "widget.delete": "removed a widget",
};

/** The same words as the app's alerts: "Errors unusually high (3.1× usual)". */
const alertWords = ({ metric, direction, value, mean }) => {
  const ratio = mean > 0 ? value / mean : null;
  const size =
    ratio === null
      ? ""
      : direction === "above"
        ? ` (${ratio.toFixed(1)}× usual)`
        : ` (${Math.round(ratio * 100)}% of usual)`;
  return `${METRIC[metric] ?? metric} unusually ${direction === "above" ? "high" : "low"}${size}`;
};

/** One readable sentence for an event, e.g. "⚠ Finance · Web App: Errors unusually high". */
const messageText = (event, data = {}) => {
  const where = [data.team, data.project].filter(Boolean).join(" · ");
  const who = data.actor?.name ?? "Someone";
  const board = data.dashboard?.name
    ? `“${data.dashboard.name}”`
    : "a dashboard";
  switch (event) {
    case "alert.opened":
      return `⚠ ${where ? `${where}: ` : ""}${alertWords(data.alert)}`;
    case "alert.resolved":
      return `✅ ${where ? `${where}: ` : ""}${METRIC[data.alert?.metric] ?? "A metric"} is back to normal`;
    case "dashboard.created":
      return `📊 ${who} created the dashboard ${board}`;
    case "dashboard.updated":
      return `✏️ ${who} ${CHANGE[data.change] ?? "changed"} on ${board}`;
    case "dashboard.deleted":
      return `🗑️ ${who} deleted the dashboard ${board}`;
    case "member.added":
      return `👋 ${data.member?.name ?? "Someone"} joined the team as ${ROLE[data.member?.role] ?? "a member"}`;
    case "member.removed":
      return `👤 ${who} removed someone from the team`;
    case "webhook.test":
      return "✅ Test message from AAFM Analytics: this connection works.";
    default:
      return `AAFM Analytics: ${event}`;
  }
};

/** The request body for a chat app; `link` (optional) points people back to the app. */
const chatBody = (format, text, link) => {
  const line = link ? `${text}\n${link}` : text;
  if (format === "slack") return JSON.stringify({ text: line });
  if (format === "discord")
    return JSON.stringify({ content: line.slice(0, 2000) });
  // teams: a Workflows webhook posts an Adaptive Card
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text, wrap: true }],
          ...(link && {
            actions: [
              { type: "Action.OpenUrl", title: "Open AAFM", url: link },
            ],
          }),
        },
      },
    ],
  });
};

/** Expected address of each chat app's webhooks, to catch a pasted wrong link early. */
const CHAT_HOSTS = {
  slack: /^hooks\.slack(-gov)?\.com$/,
  discord: /^(canary\.|ptb\.)?discord(app)?\.com$/,
};

export { chatBody, CHAT_HOSTS, messageText };
