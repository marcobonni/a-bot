const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const NEATQUEUE_WEBHOOK_PATH =
  process.env.NEATQUEUE_WEBHOOK_PATH || "/neatqueue/webhook";
const NEATQUEUE_WEBHOOK_TOKEN = process.env.NEATQUEUE_WEBHOOK_TOKEN || "";
const QUEUE_STATUS_CHANNEL_ID = process.env.QUEUE_STATUS_CHANNEL_ID || "";
const QUEUE_CHANNEL_NAME_PREFIX =
  process.env.QUEUE_CHANNEL_NAME_PREFIX || "giocatori-in-coda";
const NEATQUEUE_QUEUE_NAME = process.env.NEATQUEUE_QUEUE_NAME || "";
const RENAME_DEBOUNCE_MS = Number(process.env.RENAME_DEBOUNCE_MS || 5000);

let started = false;
let renameTimer = null;
let pendingCount = null;
let lastAppliedCount = null;

function sanitizeTextChannelName(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function buildChannelName(count) {
  return sanitizeTextChannelName(`${QUEUE_CHANNEL_NAME_PREFIX}-${count}`);
}

function shouldHandleQueue(payload) {
  if (!NEATQUEUE_QUEUE_NAME) {
    return true;
  }

  return String(payload.queue || "").toLowerCase() ===
    String(NEATQUEUE_QUEUE_NAME).toLowerCase();
}

async function renameQueueChannel(client, count) {
  if (!QUEUE_STATUS_CHANNEL_ID) {
    console.warn(
      "[queueChannelSync] QUEUE_STATUS_CHANNEL_ID non configurato. Rename saltato."
    );
    return;
  }

  const channel = await client.channels.fetch(QUEUE_STATUS_CHANNEL_ID).catch(() => null);

  if (!channel) {
    console.warn(
      `[queueChannelSync] Canale ${QUEUE_STATUS_CHANNEL_ID} non trovato.`
    );
    return;
  }

  const nextName = buildChannelName(count);

  if (channel.name === nextName) {
    lastAppliedCount = count;
    return;
  }

  await channel.setName(nextName, `Queue aggiornata: ${count} giocatori in coda`);
  lastAppliedCount = count;

  console.log(
    `[queueChannelSync] Canale rinominato in "${nextName}" (count=${count})`
  );
}

function scheduleRename(client, count) {
  pendingCount = count;

  if (renameTimer) {
    clearTimeout(renameTimer);
  }

  renameTimer = setTimeout(async () => {
    try {
      if (pendingCount === null || pendingCount === lastAppliedCount) {
        return;
      }

      await renameQueueChannel(client, pendingCount);
    } catch (error) {
      console.error("[queueChannelSync] Errore rename canale:", error);
    } finally {
      renameTimer = null;
    }
  }, RENAME_DEBOUNCE_MS);
}

function collectRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");

      if (body.length > 1024 * 1024) {
        reject(new Error("Payload troppo grande."));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function handleWebhook(req, res, client) {
  if (!NEATQUEUE_WEBHOOK_TOKEN) {
    sendJson(res, 500, {
      ok: false,
      error: "NEATQUEUE_WEBHOOK_TOKEN non configurato",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";

  if (authHeader !== NEATQUEUE_WEBHOOK_TOKEN) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  let payload;

  try {
    const rawBody = await collectRawBody(req);
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "JSON non valido" });
    return;
  }

  const action = String(payload.action || "").toUpperCase();

  if (!shouldHandleQueue(payload)) {
    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: "Queue diversa da quella configurata",
    });
    return;
  }

  if (action !== "JOIN_QUEUE" && action !== "LEAVE_QUEUE") {
    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: `Evento non gestito: ${action || "unknown"}`,
    });
    return;
  }

  const players = Array.isArray(payload.players) ? payload.players : [];
  const count = players.length;

  scheduleRename(client, count);

  sendJson(res, 200, {
    ok: true,
    action,
    queue: payload.queue || null,
    count,
  });
}

function startQueueChannelWebhookServer(client) {
  if (started) {
    return;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (req.method === "POST" && req.url === NEATQUEUE_WEBHOOK_PATH) {
        await handleWebhook(req, res, client);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (error) {
      console.error("[queueChannelSync] Errore server:", error);
      sendJson(res, 500, { ok: false, error: "Errore interno" });
    }
  });

  server.listen(PORT, () => {
    started = true;
    console.log(
      `[queueChannelSync] Webhook server in ascolto su porta ${PORT} - path ${NEATQUEUE_WEBHOOK_PATH}`
    );
  });

  return server;
}

module.exports = {
  startQueueChannelWebhookServer,
};