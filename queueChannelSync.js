const http = require("http");
const { createLogger } = require("./debug");

const PORT = Number(process.env.PORT || 3000);
const RAW_WEBHOOK_PATH = process.env.NEATQUEUE_WEBHOOK_PATH || "/neatqueue/webhook";
const NEATQUEUE_WEBHOOK_TOKEN = process.env.NEATQUEUE_WEBHOOK_TOKEN || "";

const QUEUE_STATUS_CHANNEL_ID = process.env.QUEUE_STATUS_CHANNEL_ID || "";
const QUEUE_CHANNEL_NAME_PREFIX =
  process.env.QUEUE_CHANNEL_NAME_PREFIX || "giocatori-in-coda";

const QUEUE_VOICE_CHANNEL_ID = process.env.QUEUE_VOICE_CHANNEL_ID || "";
const QUEUE_VOICE_IDLE_NAME = process.env.QUEUE_VOICE_IDLE_NAME || "zozza-disponibile";
const QUEUE_VOICE_ACTIVE_NAME = process.env.QUEUE_VOICE_ACTIVE_NAME || "zozza-in-corso";

const NEATQUEUE_QUEUE_NAME = process.env.NEATQUEUE_QUEUE_NAME || "";
const RENAME_DEBOUNCE_MS = Number(process.env.RENAME_DEBOUNCE_MS || 5000);
const logger = createLogger("queueChannelSync");

let started = false;
let renameTimer = null;
let pendingCount = null;
let lastAppliedCount = null;
let matchInProgress = false;

function normalizePath(path) {
  const value = String(path || "").trim();
  if (!value) return "/";
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

const NEATQUEUE_WEBHOOK_PATH = normalizePath(RAW_WEBHOOK_PATH);

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

function normalizeActionName(action) {
  return String(action || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "_");
}

function shouldHandleQueue(payload) {
  if (!NEATQUEUE_QUEUE_NAME) {
    logger.info("NEATQUEUE_QUEUE_NAME non configurato: accetto tutti gli eventi.");
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

  logger.debug("Confronto queue webhook", {
    wantedQueue,
    payloadQueueCandidates,
    match,
  });

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

function isClearQueueAction(action) {
  const normalized = normalizeActionName(action);
  return normalized === "CLEARQUEUE" || normalized === "CLEAR_QUEUE";
}

function isMatchActiveAction(action) {
  const normalized = normalizeActionName(action);
  return (
    normalized === "MATCH_STARTED" ||
    normalized === "TEAMS_CREATED" ||
    normalized === "MATCH_CREATED" ||
    normalized === "GAME_STARTED"
  );
}

function isMatchIdleAction(action) {
  const normalized = normalizeActionName(action);
  return (
    normalized === "MATCH_COMPLETED" ||
    normalized === "MATCH_CANCELLED" ||
    normalized === "MATCH_ENDED" ||
    normalized === "GAME_ENDED"
  );
}

function extractCount(payload, action) {
  const players = extractPlayersArray(payload);

  if (players.length > 0) {
    return players.length;
  }

  const numericCandidates = [
    payload?.count,
    payload?.playerCount,
    payload?.player_count,
    payload?.queueCount,
    payload?.queue_count,
    payload?.data?.count,
    payload?.data?.playerCount,
    payload?.data?.player_count,
    payload?.data?.queueCount,
    payload?.data?.queue_count,
  ];

  for (const candidate of numericCandidates) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return numericValue;
    }
  }

  if (isClearQueueAction(action)) {
    console.log("[queueChannelSync] Evento clear queue rilevato: imposto count a 0");
    return 0;
  }

  return players.length;
}

async function renameChannelById(client, channelId, nextName, reason) {
  if (!channelId) {
    console.warn("[queueChannelSync] channelId mancante, rename saltato.");
    return;
  }

  const channel = await client.channels.fetch(channelId).catch((error) => {
    console.error("[queueChannelSync] Errore fetch channel:", error);
    return null;
  });

  if (!channel) {
    console.warn(`[queueChannelSync] Canale ${channelId} non trovato.`);
    return;
  }

  console.log("[queueChannelSync] Canale trovato:", {
    id: channel.id,
    name: channel.name,
    type: channel.type,
  });
  console.log("[queueChannelSync] Nuovo nome previsto:", nextName);

  if (channel.name === nextName) {
    console.log("[queueChannelSync] Il canale ha già il nome corretto. Nessun rename.");
    return;
  }

  await channel.setName(nextName, reason);
  console.log(`[queueChannelSync] Canale rinominato con successo in "${nextName}"`);
}

async function renameQueueChannel(client, count) {
  logger.info("renameQueueChannel avviato", {
    channelId: QUEUE_STATUS_CHANNEL_ID,
    count,
  });

  if (!QUEUE_STATUS_CHANNEL_ID) {
    console.warn("[queueChannelSync] QUEUE_STATUS_CHANNEL_ID non configurato.");
    return;
  }

  const nextName = buildChannelName(count);

  try {
    await renameChannelById(
      client,
      QUEUE_STATUS_CHANNEL_ID,
      nextName,
      `Queue aggiornata: ${count} giocatori in coda`
    );
    lastAppliedCount = count;
  } catch (error) {
    console.error("[queueChannelSync] Errore durante rename queue channel:", error);
    throw error;
  }
}

async function renameVoiceStatusChannel(client, isActive) {
  if (!QUEUE_VOICE_CHANNEL_ID) {
    console.log("[queueChannelSync] QUEUE_VOICE_CHANNEL_ID non configurato: salto rename vocale.");
    return;
  }

  const nextName = isActive ? QUEUE_VOICE_ACTIVE_NAME : QUEUE_VOICE_IDLE_NAME;
  const reason = isActive ? "Match in corso" : "Match terminato o annullato";

  try {
    await renameChannelById(client, QUEUE_VOICE_CHANNEL_ID, nextName, reason);
  } catch (error) {
    console.error("[queueChannelSync] Errore durante rename voice status channel:", error);
  }
}

async function setMatchState(client, nextState, action) {
  logger.info("Cambio stato match richiesto", {
    current: matchInProgress,
    next: nextState,
    action: action || null,
  });

  if (matchInProgress === nextState) {
    console.log("[queueChannelSync] Stato match invariato. Nessun rename vocale necessario.");
    return;
  }

  matchInProgress = nextState;
  await renameVoiceStatusChannel(client, matchInProgress);
}

function scheduleRename(client, count) {
  logger.debug("scheduleRename chiamato", {
    count,
    lastAppliedCount,
    pendingCount,
  });

  pendingCount = count;

  if (renameTimer) {
    console.log("[queueChannelSync] Timer esistente trovato. Lo resetto.");
    clearTimeout(renameTimer);
  }

  renameTimer = setTimeout(async () => {
    logger.debug("Timer rename scattato", {
      pendingCount,
      lastAppliedCount,
    });

    try {
      if (pendingCount === null) {
        console.log("[queueChannelSync] pendingCount nullo. Esco.");
        return;
      }

      if (pendingCount === lastAppliedCount) {
        console.log("[queueChannelSync] Count uguale all'ultimo applicato. Nessun rename necessario.");
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
  logger.info("Webhook ricevuto", {
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  if (!NEATQUEUE_WEBHOOK_TOKEN) {
    console.error("[queueChannelSync] NEATQUEUE_WEBHOOK_TOKEN non configurato");
    sendJson(res, 500, { ok: false, error: "NEATQUEUE_WEBHOOK_TOKEN non configurato" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  logger.debug("Verifica authorization webhook", {
    received: authHeader,
    expected: NEATQUEUE_WEBHOOK_TOKEN,
  });

  if (authHeader !== NEATQUEUE_WEBHOOK_TOKEN) {
    console.warn("[queueChannelSync] Authorization non valida");
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  let payload;
  let rawBody = "";

  try {
    rawBody = await collectRawBody(req);
    logger.debug("Raw body webhook", { rawBody });
    payload = JSON.parse(rawBody || "{}");
  } catch (error) {
    console.error("[queueChannelSync] Errore parsing JSON:", error);
    sendJson(res, 400, { ok: false, error: "JSON non valido" });
    return;
  }

  logger.debug("Payload webhook parsato", payload);

  const action = extractAction(payload);
  const players = extractPlayersArray(payload);
  const count = extractCount(payload, action);

  logger.info("Webhook interpretato", {
    action: action || null,
    playersCount: players.length,
    count,
  });

  if (!shouldHandleQueue(payload)) {
    console.log("[queueChannelSync] Evento ignorato: queue non corrispondente");
    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: "Queue diversa da quella configurata",
    });
    return;
  }

  if (isMatchActiveAction(action)) {
    console.log("[queueChannelSync] Match rilevato come attivo");
    await setMatchState(client, true, action);
  } else if (isMatchIdleAction(action)) {
    console.log("[queueChannelSync] Match rilevato come terminato/idle");
    await setMatchState(client, false, action);
  } else {
    console.log("[queueChannelSync] Nessun cambio stato match richiesto da questo evento");
  }

  console.log("[queueChannelSync] Evento accettato, pianifico rename coda");
  scheduleRename(client, count);

  sendJson(res, 200, {
    ok: true,
    action: action || null,
    count,
    matchInProgress,
    received: true,
  });
}

function startQueueChannelWebhookServer(client) {
  if (started) {
    console.log("[queueChannelSync] Server già avviato");
    return;
  }

  logger.info("Avvio webhook server", {
    port: PORT,
    webhookPath: NEATQUEUE_WEBHOOK_PATH,
    queueStatusChannelId: QUEUE_STATUS_CHANNEL_ID,
    queueVoiceChannelId: QUEUE_VOICE_CHANNEL_ID || null,
    queueChannelNamePrefix: QUEUE_CHANNEL_NAME_PREFIX,
    neatqueueQueueName: NEATQUEUE_QUEUE_NAME || null,
    renameDebounceMs: RENAME_DEBOUNCE_MS,
    debugEnabled: logger.enabled(),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const requestPath = normalizePath(req.url);

      console.log("--------------------------------------------------");
      console.log("[queueChannelSync] Richiesta ricevuta");
      console.log("[queueChannelSync] req.method:", req.method);
      console.log("[queueChannelSync] req.url:", req.url);
      console.log("[queueChannelSync] requestPath normalizzato:", requestPath);
      console.log("[queueChannelSync] path atteso:", NEATQUEUE_WEBHOOK_PATH);

      if ((req.method === "GET" || req.method === "HEAD") && requestPath === "/") {
        console.log("[queueChannelSync] Healthcheck /");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (req.method === "POST" && requestPath === NEATQUEUE_WEBHOOK_PATH) {
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
