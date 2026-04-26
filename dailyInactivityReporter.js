const fs = require("fs");
const path = require("path");
const { createLogger } = require("./debug");

const DEFAULT_REPORT_HOUR = 20;
const DEFAULT_REPORT_MINUTE = 0;
const STATE_FILE = path.join(__dirname, "dailyInactivityReporterState.json");
const logger = createLogger("dailyInactivityReporter");

const config = {
  enabled: false,
  guildId: null,
  channelId: null,
  userId: null,
  reportHour: DEFAULT_REPORT_HOUR,
  reportMinute: DEFAULT_REPORT_MINUTE,
};

const runtimeState = {
  initialized: false,
  started: false,
  timeoutId: null,
  data: {
    lastOnlineAt: null,
    currentStatus: "offline",
    lastStatusChangeAt: null,
  },
};

function readStateFile() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastOnlineAt: null,
      currentStatus: "offline",
      lastStatusChangeAt: null,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      lastOnlineAt: raw?.lastOnlineAt || null,
      currentStatus: raw?.currentStatus || "offline",
      lastStatusChangeAt: raw?.lastStatusChangeAt || null,
    };
  } catch (error) {
    logger.warn("State file non leggibile, uso stato vuoto.", {
      error: error.message,
    });
    return {
      lastOnlineAt: null,
      currentStatus: "offline",
      lastStatusChangeAt: null,
    };
  }
}

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(runtimeState.data, null, 2), "utf8");
}

function getNextRunDelayMs(now = new Date()) {
  const nextRun = new Date(now);
  nextRun.setHours(config.reportHour, config.reportMinute, 0, 0);

  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) {
    parts.push(`${days} giorno${days === 1 ? "" : "i"}`);
  }

  if (hours) {
    parts.push(`${hours} ora${hours === 1 ? "" : "e"}`);
  }

  if (minutes || !parts.length) {
    parts.push(`${minutes} minuto${minutes === 1 ? "" : "i"}`);
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

function isOnlineStatus(status) {
  return status === "online" || status === "idle" || status === "dnd";
}

function normalizePresenceStatus(status) {
  if (!status) {
    return "offline";
  }

  return String(status).toLowerCase();
}

async function sendDailyReport(client) {
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await guild.channels.fetch(config.channelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error("Il canale configurato per il report non e testuale.");
  }

  const now = Date.now();
  const { currentStatus, lastOnlineAt } = runtimeState.data;
  let content = "";

  if (isOnlineStatus(currentStatus)) {
    content = `<@${config.userId}> e online ora su **${guild.name}**.`;
  } else if (lastOnlineAt) {
    const elapsed = formatDuration(now - new Date(lastOnlineAt).getTime());
    content = `<@${config.userId}> non si collega su **${guild.name}** da **${elapsed}**.`;
  } else {
    content = `Non ho ancora uno storico sufficiente per dire da quanto tempo <@${config.userId}> non si collega su **${guild.name}**.`;
  }

  await channel.send({ content });
  logger.info("Report giornaliero inviato", {
    guildId: config.guildId,
    channelId: config.channelId,
    userId: config.userId,
    currentStatus,
    lastOnlineAt,
  });
}

function scheduleNextReport(client) {
  if (runtimeState.timeoutId) {
    clearTimeout(runtimeState.timeoutId);
  }

  const delayMs = getNextRunDelayMs();
  runtimeState.timeoutId = setTimeout(async () => {
    try {
      await sendDailyReport(client);
    } catch (error) {
      logger.error("Errore invio report giornaliero", {
        error: error.message,
      });
    } finally {
      scheduleNextReport(client);
    }
  }, delayMs);

  logger.info("Prossimo report pianificato", {
    inMinutes: Math.round(delayMs / 60000),
    hour: config.reportHour,
    minute: config.reportMinute,
  });
}

function updatePresenceState(status, changedAt = new Date().toISOString()) {
  const normalizedStatus = normalizePresenceStatus(status);
  const wasOnline = isOnlineStatus(runtimeState.data.currentStatus);
  const isNowOnline = isOnlineStatus(normalizedStatus);

  runtimeState.data.currentStatus = normalizedStatus;
  runtimeState.data.lastStatusChangeAt = changedAt;

  if (isNowOnline) {
    runtimeState.data.lastOnlineAt = changedAt;
  } else if (wasOnline && !runtimeState.data.lastOnlineAt) {
    runtimeState.data.lastOnlineAt = changedAt;
  }

  persistState();
}

function handlePresenceUpdate(oldPresence, newPresence) {
  if (!config.enabled) {
    return;
  }

  const presence = newPresence || oldPresence;

  if (!presence || presence.guild?.id !== config.guildId || presence.userId !== config.userId) {
    return;
  }

  const oldStatus = normalizePresenceStatus(oldPresence?.status);
  const newStatus = normalizePresenceStatus(newPresence?.status);

  if (oldStatus === newStatus) {
    return;
  }

  updatePresenceState(newStatus);
  logger.info("Presenza target aggiornata", {
    userId: config.userId,
    oldStatus,
    newStatus,
  });
}

async function initializePresenceState(client) {
  const guild = await client.guilds.fetch(config.guildId);
  await guild.members.fetch(config.userId);

  const member = guild.members.cache.get(config.userId);
  const currentStatus = normalizePresenceStatus(member?.presence?.status);

  if (!runtimeState.data.lastOnlineAt && isOnlineStatus(currentStatus)) {
    updatePresenceState(currentStatus);
    return;
  }

  runtimeState.data.currentStatus = currentStatus;
  persistState();
}

async function startDailyInactivityReporter(client) {
  const userId = String(process.env.DAILY_INACTIVITY_TARGET_USER_ID || "").trim();
  const channelId = String(process.env.DAILY_INACTIVITY_CHANNEL_ID || "").trim();
  const guildId = String(
    process.env.DAILY_INACTIVITY_GUILD_ID || process.env.DISCORD_GUILD_ID || ""
  ).trim();
  const reportHour = Number(process.env.DAILY_INACTIVITY_REPORT_HOUR || DEFAULT_REPORT_HOUR);
  const reportMinute = Number(
    process.env.DAILY_INACTIVITY_REPORT_MINUTE || DEFAULT_REPORT_MINUTE
  );

  if (!userId || !channelId || !guildId) {
    logger.info("Reporter inattivita disabilitato: configurazione assente.");
    return;
  }

  config.enabled = true;
  config.userId = userId;
  config.channelId = channelId;
  config.guildId = guildId;
  config.reportHour = Number.isInteger(reportHour) ? reportHour : DEFAULT_REPORT_HOUR;
  config.reportMinute = Number.isInteger(reportMinute) ? reportMinute : DEFAULT_REPORT_MINUTE;

  if (!runtimeState.initialized) {
    runtimeState.data = readStateFile();
    runtimeState.initialized = true;
  }

  if (runtimeState.started) {
    return;
  }

  await initializePresenceState(client);
  scheduleNextReport(client);
  runtimeState.started = true;

  logger.info("Reporter inattivita avviato", {
    guildId: config.guildId,
    channelId: config.channelId,
    userId: config.userId,
    reportHour: config.reportHour,
    reportMinute: config.reportMinute,
  });
}

module.exports = {
  handlePresenceUpdate,
  startDailyInactivityReporter,
};
