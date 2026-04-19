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

function normalizeQueueName(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldHandleQueue(payload) {
  if (!NEATQUEUE_QUEUE_NAME) {
    console.log(
      "[queueChannelSync] NEATQUEUE_QUEUE_NAME non configurato: accetto tutti gli eventi."
    );
    return true;
  }

  const payloadQueueCandidates = [
    payload?.queue,
    payload?.queueName,
    payload?.queue_name,
    payload?.name,
    payload?.data?.queue,
    payload?.data?.queueName,
    payload?.data?.queue_name,
    payload?.queue?.name,
  ]
    .map(normalizeQueueName)
    .filter(Boolean);

  const wantedQueue = normalizeQueueName(NEATQUEUE_QUEUE_NAME);
  const match = payloadQueueCandidates.includes(wantedQueue);

  console.log("[queueChannelSync] Queue configurata:", wantedQueue);
  console.log("[queueChannelSync] Queue trovate nel payload:", payloadQueueCandidates);
  console.log("[queueChannelSync] Match queue:", match);

  return match;
}

function extractPlayersArray(payload) {
  const candidates = [
    payload?.players,
    payload?.queue?.players,
    payload?.data?.players,
    payload?.data?.queue?.players,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractAction(payload) {
  const candidates = [
    payload?.action,
    payload?.event,
    payload?.type,
    payload?.name,
    payload?.data?.action,
    payload?.data?.event,
    payload?.data?.type,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return String(candidate).toUpperCase();
    }
  }

  return "";
}

async function renameQueueChannel(client, count) {
  console.log("[queueChannelSync] renameQueueChannel avviato");
  console.log("[queueChannelSync] QUEUE_STATUS_CHANNEL_ID:", QUEUE_STATUS_CHANNEL_ID);
  console.log("[queueChannelSync] Count richiesto:", count);

  if (!QUEUE_STATUS_CHANNEL_ID) {
    console.warn(
      "[queueChannelSync] QUEUE_STATUS_CHANNEL_ID non configurato. Rename saltato."
    );
    return;
  }

  const channel = await client.channels.fetch(QUEUE_STATUS_CHANNEL_ID).catch((error) => {
    console.error("[queueChannelSync] Errore fetch channel:", error);
    return null;
  });

  if (!channel) {
    console.warn(
      `[queueChannelSync] Canale ${QUEUE_STATUS_CHANNEL_ID} non trovato.`
    );
    return;
  }

  const nextName = buildChannelName(count);

  console.log("[queueChannelSync] Canale trovato:", {
    id: channel.id,
    name: channel.name,
    type: channel.type,
  });
  console.log("[queueChannelSync] Nuovo nome previsto:", nextName);

  if (channel.name === nextName) {
    console.log("[queueChannelSync] Il canale ha già il nome corretto. Nessun rename.");
    lastAppliedCount = count;
    return;
  }

  try {
    await channel.setName(nextName, `Queue aggiornata: ${count} giocatori in coda`);
    lastAppliedCount = count;

    console.log(
      `[queueChannelSync] Canale rinominato con successo in "${nextName}" (count=${count})`
    );
  } catch (error) {
    console.error("[queueChannelSync] Errore durante setName:", error);
    throw error;
  }
}

function scheduleRename(client, count) {
  console.log("[queueChannelSync] scheduleRename chiamato con count:", count);
  console.log("[queueChannelSync] lastAppliedCount:", lastAppliedCount);
  console.log("[queueChannelSync] pendingCount precedente:", pendingCount);

  pendingCount = count;

  if (renameTimer) {
    console.log("[queueChannelSync] Timer esistente trovato. Lo resetto.");
    clearTimeout(renameTimer);
  }

  renameTimer = setTimeout(async () => {
    console.log("[queueChannelSync] Timer rename scattato");
    console.log("[queueChannelSync] pendingCount:", pendingCount);
    console.log("[queueChannelSync] lastAppliedCount:", lastAppliedCount);

    try {
      if (pendingCount === null) {
        console.log("[queueChannelSync] pendingCount nullo. Esco.");
        return;
      }

      if (pendingCount === lastAppliedCount) {
        console.log(
          "[queueChannelSync] Count uguale all'ultimo applicato. Nessun rename necessario."
        );
        return;
      }

      await renameQueueChannel(client, pendingCount);
    } catch (error) {
      console.error("[queueChannelSync] Errore rename canale:", error);
    } finally {
      renameTimer = null;
      console.log("[queueChannelSync] Timer rename chiuso");
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
  console.log("==================================================");
  console.log("[queueChannelSync] WEBHOOK RICEVUTO");
  console.log("[queueChannelSync] Method:", req.method);
  console.log("[queueChannelSync] URL:", req.url);
  console.log("[queueChannelSync] Headers:", req.headers);
  console.log("[queueChannelSync] Path atteso:", NEATQUEUE_WEBHOOK_PATH);

  if (!NEATQUEUE_WEBHOOK_TOKEN) {
    console.error("[queueChannelSync] NEATQUEUE_WEBHOOK_TOKEN non configurato");
    sendJson(res, 500, {
      ok: false,
      error: "NEATQUEUE_WEBHOOK_TOKEN non configurato",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  console.log("[queueChannelSync] Authorization ricevuto:", authHeader);
  console.log("[queueChannelSync] Authorization atteso:", NEATQUEUE_WEBHOOK_TOKEN);

  if (authHeader !== NEATQUEUE_WEBHOOK_TOKEN) {
    console.warn("[queueChannelSync] Authorization non valida");
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  let payload;
  let rawBody = "";

  try {
    rawBody = await collectRawBody(req);
    console.log("[queueChannelSync] Raw body:", rawBody);
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    console.error("[queueChannelSync] Errore parsing JSON:", error);
    sendJson(res, 400, { ok: false, error: "JSON non valido" });
    return;
  }

  console.log("[queueChannelSync] Payload parsato:", payload);

  const action = extractAction(payload);
  const players = extractPlayersArray(payload);
  const count = players.length;

  console.log("[queueChannelSync] Action estratta:", action);
  console.log("[queueChannelSync] Players estratti:", players);
  console.log("[queueChannelSync] Count estratto:", count);

  if (!shouldHandleQueue(payload)) {
    console.log("[queueChannelSync] Evento ignorato: queue non corrispondente");
    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: "Queue diversa da quella configurata",
    });
    return;
  }

  if (action && action !== "JOIN_QUEUE" && action !== "LEAVE_QUEUE") {
    console.log("[queueChannelSync] Evento ignorato:", action);
    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: `Evento non gestito: ${action}`,
    });
    return;
  }

  console.log("[queueChannelSync] Evento accettato, pianifico rename");
  scheduleRename(client, count);

  sendJson(res, 200, {
    ok: true,
    action: action || null,
    count,
    received: true,
  });
}

function startQueueChannelWebhookServer(client) {
  if (started) {
    console.log("[queueChannelSync] Server già avviato");
    return;
  }

  console.log("[queueChannelSync] Avvio webhook server...");
  console.log("[queueChannelSync] PORT:", PORT);
  console.log("[queueChannelSync] NEATQUEUE_WEBHOOK_PATH:", NEATQUEUE_WEBHOOK_PATH);
  console.log("[queueChannelSync] QUEUE_STATUS_CHANNEL_ID:", QUEUE_STATUS_CHANNEL_ID);
  console.log("[queueChannelSync] QUEUE_CHANNEL_NAME_PREFIX:", QUEUE_CHANNEL_NAME_PREFIX);
  console.log("[queueChannelSync] NEATQUEUE_QUEUE_NAME:", NEATQUEUE_QUEUE_NAME || "(tutte)");
  console.log("[queueChannelSync] RENAME_DEBOUNCE_MS:", RENAME_DEBOUNCE_MS);

  const server = http.createServer(async (req, res) => {
    try {
      console.log("--------------------------------------------------");
      console.log("[queueChannelSync] Richiesta ricevuta");
      console.log("[queueChannelSync] req.method:", req.method);
      console.log("[queueChannelSync] req.url:", req.url);

      if (req.method === "GET" && req.url === "/") {
        console.log("[queueChannelSync] Healthcheck /");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (req.method === "POST" && req.url === NEATQUEUE_WEBHOOK_PATH) {
        console.log("[queueChannelSync] Match esatto sul webhook path");
        await handleWebhook(req, res, client);
        return;
      }

      console.log("[queueChannelSync] Nessun match route. Rispondo 404.");
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