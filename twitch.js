const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DISCORD_LIVE_CHANNEL_ID = process.env.DISCORD_LIVE_CHANNEL_ID;
const { createLogger } = require("./debug");
const TWITCH_STREAMERS = (process.env.TWITCH_STREAMERS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const TWITCH_POLL_INTERVAL_MS = 2 * 60 * 1000;
const AGERS_ROLE_NAME = "Agers";
const AGERS_PING_STREAMERS = new Set(["aoe4italia_legacy"]);
const logger = createLogger("twitch");

let twitchAccessToken = null;
let twitchAccessTokenExpiresAt = 0;

const liveStatusCache = new Map();
const liveMessages = new Map(); // Salva messageId per streamer.

async function fetchJson(url, errorPrefix, options = {}) {
  logger.debug("HTTP request", {
    url,
    method: options.method || "GET",
  });
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }

  return response.json();
}

async function getTwitchAppAccessToken() {
  const now = Date.now();

  if (twitchAccessToken && now < twitchAccessTokenExpiresAt - 60_000) {
    logger.debug("Riutilizzo token Twitch in cache");
    return twitchAccessToken;
  }

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("Mancano TWITCH_CLIENT_ID o TWITCH_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const data = await fetchJson(
    "https://id.twitch.tv/oauth2/token",
    "Errore token Twitch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  twitchAccessToken = data.access_token;
  twitchAccessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  logger.debug("Nuovo token Twitch ottenuto", {
    expiresInSeconds: data.expires_in,
  });

  return twitchAccessToken;
}

async function getLiveStreamsByLogins(logins) {
  if (!logins.length) return [];

  logger.debug("Controllo streamer Twitch", { logins });

  const token = await getTwitchAppAccessToken();

  const params = new URLSearchParams();
  for (const login of logins) {
    params.append("user_login", login);
  }

  const data = await fetchJson(
    `https://api.twitch.tv/helix/streams?${params.toString()}`,
    "Errore Twitch Get Streams",
    {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return data.data || [];
}

function shouldPingAgers(stream) {
  return AGERS_PING_STREAMERS.has(stream.user_login.toLowerCase());
}

async function getAgersRoleMention(channel) {
  const guild = channel.guild;

  if (!guild) {
    return "";
  }

  if (guild.roles.cache.size === 0) {
    await guild.roles.fetch();
  }

  const agersRole = guild.roles.cache.find(
    (role) => role.name.toLowerCase() === AGERS_ROLE_NAME.toLowerCase()
  );

  logger.debug("Lookup ruolo Agers", {
    found: Boolean(agersRole),
    guildId: guild.id,
  });

  return agersRole ? `<@&${agersRole.id}>` : "";
}

function buildTwitchLiveMessage(stream, roleMention = "") {
  const prefix = roleMention ? `${roleMention}\n` : "";
  return `${prefix}🔴 **${stream.user_name} è LIVE!**\nhttps://twitch.tv/${stream.user_login}`;
}

async function notifyDiscordLive(client, stream) {
  const channel = await client.channels.fetch(DISCORD_LIVE_CHANNEL_ID);
  const roleMention = shouldPingAgers(stream)
    ? await getAgersRoleMention(channel)
    : "";

  logger.info("Invio messaggio live", {
    streamer: stream.user_login,
    pingAgers: Boolean(roleMention),
    channelId: channel?.id || null,
  });

  const message = await channel.send({
    content: buildTwitchLiveMessage(stream, roleMention),
  });

  liveMessages.set(stream.user_login.toLowerCase(), message.id);
}

async function removeDiscordLiveMessage(client, streamer) {
  const messageId = liveMessages.get(streamer);

  if (!messageId) return;

  logger.debug("Rimozione messaggio live", { streamer, messageId });

  try {
    const channel = await client.channels.fetch(DISCORD_LIVE_CHANNEL_ID);
    const message = await channel.messages.fetch(messageId);

    if (message) {
      await message.delete();
    }
  } catch (err) {
    console.error("Errore cancellazione messaggio:", err.message);
  }

  liveMessages.delete(streamer);
}

async function pollTwitchLives(client) {
  if (!TWITCH_STREAMERS.length) return;

  logger.debug("Poll Twitch avviato", {
    monitored: TWITCH_STREAMERS,
  });

  const liveStreams = await getLiveStreamsByLogins(TWITCH_STREAMERS);

  const currentlyLive = new Set(
    liveStreams.map((stream) => stream.user_login.toLowerCase())
  );

  for (const streamer of TWITCH_STREAMERS) {
    const key = streamer.toLowerCase();
    const wasLive = liveStatusCache.get(key) === true;
    const isLive = currentlyLive.has(key);

    if (!wasLive && isLive) {
      const stream = liveStreams.find(
        (candidate) => candidate.user_login.toLowerCase() === key
      );

      if (stream) {
        logger.info("Streamer rilevato live", { streamer: key });
        await notifyDiscordLive(client, stream);
      }
    }

    if (wasLive && !isLive) {
      logger.info("Streamer rilevato offline", { streamer: key });
      await removeDiscordLiveMessage(client, key);
    }

    liveStatusCache.set(key, isLive);
  }
}

function startTwitchMonitor(client) {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !DISCORD_LIVE_CHANNEL_ID) {
    console.log("Monitor Twitch disattivato: mancano variabili ambiente.");
    return;
  }

  if (!TWITCH_STREAMERS.length) {
    console.log("Monitor Twitch disattivato: nessuno streamer.");
    return;
  }

  logger.info("Monitor Twitch attivo", {
    intervalMs: TWITCH_POLL_INTERVAL_MS,
    streamers: TWITCH_STREAMERS,
    debugEnabled: logger.enabled(),
  });

  pollTwitchLives(client).catch(console.error);

  setInterval(async () => {
    try {
      await pollTwitchLives(client);
    } catch (error) {
      console.error("Errore controllo Twitch:", error);
    }
  }, TWITCH_POLL_INTERVAL_MS);
}

module.exports = {
  startTwitchMonitor,
};
