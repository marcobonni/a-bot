const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DISCORD_LIVE_CHANNEL_ID = process.env.DISCORD_LIVE_CHANNEL_ID;
const { createLogger } = require("./debug");
const {
  ensureMonitorStore,
  loadTwitchSubscriptions,
  upsertTwitchSubscription,
  removeTwitchSubscription,
} = require("./monitorStore");

const TWITCH_POLL_INTERVAL_MS = 2 * 60 * 1000;
const AGERS_ROLE_NAME = "Agers";
const AGERS_PING_STREAMERS = new Set(["aoe4italia_legacy"]);
const TWITCH_TARGET_GAME_NAME = "Age of Empires IV";
const logger = createLogger("twitch");

let twitchAccessToken = null;
let twitchAccessTokenExpiresAt = 0;
let pollInFlight = false;

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

async function getUsersByLogins(logins) {
  if (!logins.length) return [];

  const token = await getTwitchAppAccessToken();
  const params = new URLSearchParams();

  for (const login of logins) {
    params.append("login", login);
  }

  const data = await fetchJson(
    `https://api.twitch.tv/helix/users?${params.toString()}`,
    "Errore Twitch Get Users",
    {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return data.data || [];
}

function normalizeTwitchInput(input) {
  const value = String(input || "").trim();

  if (!value) {
    throw new Error("Inserisci un canale Twitch valido.");
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (!parts.length) {
        throw new Error("Link Twitch non valido.");
      }

      return parts[0].toLowerCase();
    } catch (error) {
      throw new Error("Link Twitch non valido.");
    }
  }

  return value.replace(/^@/, "").toLowerCase();
}

async function resolveTwitchChannel(input) {
  const login = normalizeTwitchInput(input);
  const users = await getUsersByLogins([login]);
  const user = users[0];

  if (!user) {
    throw new Error("Canale Twitch non trovato.");
  }

  return {
    login: String(user.login).toLowerCase(),
    displayName: user.display_name || user.login,
    url: `https://twitch.tv/${String(user.login).toLowerCase()}`,
  };
}

function formatTwitchSubscription(subscription) {
  return `- **${subscription.displayName || subscription.login}** - ${subscription.url} - login \`${subscription.login}\``;
}

function findTwitchSubscriptionByText(subscriptions, query) {
  const normalizedQuery = normalizeTwitchInput(query);

  const exact = subscriptions.find((subscription) =>
    [subscription.login, subscription.displayName, subscription.url]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === normalizedQuery)
  );

  if (exact) {
    return exact;
  }

  const partialMatches = subscriptions.filter((subscription) =>
    String(subscription.displayName || subscription.login)
      .toLowerCase()
      .includes(normalizedQuery)
  );

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    throw new Error("Ho trovato piu canali Twitch con quel nome. Usa il link completo o il login.");
  }

  return null;
}

async function addTwitchSubscriptionByInput(input) {
  await ensureMonitorStore();

  const resolved = await resolveTwitchChannel(input);
  const existing = (await loadTwitchSubscriptions()).find(
    (subscription) => String(subscription.login).toLowerCase() === resolved.login
  );

  const subscription = await upsertTwitchSubscription({
    login: resolved.login,
    displayName: resolved.displayName,
    url: resolved.url,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastStreamId: existing?.lastStreamId || null,
    lastLiveMessageId: existing?.lastLiveMessageId || null,
    lastSeenLiveAt: existing?.lastSeenLiveAt || null,
  });

  return {
    subscription,
    alreadyExists: Boolean(existing),
  };
}

async function removeTwitchSubscriptionByInput(input) {
  await ensureMonitorStore();

  const subscriptions = await loadTwitchSubscriptions();
  let match = findTwitchSubscriptionByText(subscriptions, input);

  if (!match) {
    try {
      const resolved = await resolveTwitchChannel(input);
      match = subscriptions.find(
        (subscription) => String(subscription.login).toLowerCase() === resolved.login
      );
    } catch (error) {
      logger.debug("Risoluzione canale Twitch fallita durante remove", {
        input,
        message: error.message,
      });
    }
  }

  if (!match) {
    return null;
  }

  return await removeTwitchSubscription(match.login);
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
  return `${prefix}**${stream.user_name} e live!**\nhttps://twitch.tv/${stream.user_login}`;
}

function isTargetTwitchGame(stream) {
  return String(stream?.game_name || "").trim().toLowerCase() ===
    TWITCH_TARGET_GAME_NAME.toLowerCase();
}

function shouldPingAgers(stream) {
  return AGERS_PING_STREAMERS.has(String(stream?.user_login || "").toLowerCase());
}

async function notifyDiscordLive(client, subscription, stream) {
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

  await upsertTwitchSubscription({
    ...subscription,
    displayName: stream.user_name || subscription.displayName,
    url: subscription.url || `https://twitch.tv/${subscription.login}`,
    lastStreamId: stream.id || subscription.lastStreamId || null,
    lastLiveMessageId: message.id,
    lastSeenLiveAt: new Date().toISOString(),
  });
}

async function removeDiscordLiveMessage(client, subscription) {
  const messageId = subscription.lastLiveMessageId;

  if (!messageId) {
    return;
  }

  logger.debug("Rimozione messaggio live", {
    streamer: subscription.login,
    messageId,
  });

  try {
    const channel = await client.channels.fetch(DISCORD_LIVE_CHANNEL_ID);
    const message = await channel.messages.fetch(messageId);

    if (message) {
      await message.delete();
    }
  } catch (error) {
    logger.warn("Errore cancellazione messaggio live Twitch", {
      streamer: subscription.login,
      message: error.message,
    });
  }

  await upsertTwitchSubscription({
    ...subscription,
    lastLiveMessageId: null,
  });
}

async function pollTwitchLives(client) {
  if (pollInFlight) {
    logger.warn("Poll Twitch saltato: controllo precedente ancora in corso");
    return;
  }

  pollInFlight = true;

  try {
    const subscriptions = await loadTwitchSubscriptions();
    if (!subscriptions.length) return;

    const logins = subscriptions.map((subscription) => subscription.login);

    logger.debug("Poll Twitch avviato", {
      monitored: logins,
    });

    const liveStreams = await getLiveStreamsByLogins(logins);
    const currentlyLive = new Set(
      liveStreams.map((stream) => String(stream.user_login).toLowerCase())
    );

    for (const subscription of subscriptions) {
      const key = String(subscription.login).toLowerCase();
      const anyLiveStream = liveStreams.find(
        (candidate) => String(candidate.user_login).toLowerCase() === key
      );
      const isPlayingTargetGame = isTargetTwitchGame(anyLiveStream);
      const stream = isPlayingTargetGame ? anyLiveStream : null;
      const isLive = Boolean(stream);
      const wasLive = Boolean(subscription.lastLiveMessageId);

      if (!wasLive && isLive) {
        logger.info("Streamer rilevato live", { streamer: key });
        await notifyDiscordLive(client, subscription, stream);
        continue;
      }

      if (wasLive && !isLive) {
        logger.info("Streamer rilevato offline", { streamer: key });
        await removeDiscordLiveMessage(client, subscription);
        continue;
      }

      if (isLive) {
        await upsertTwitchSubscription({
          ...subscription,
          displayName: stream.user_name || subscription.displayName,
          lastStreamId: stream.id || subscription.lastStreamId || null,
          lastSeenLiveAt: new Date().toISOString(),
        });
      } else if (anyLiveStream) {
        logger.debug("Streamer live ma non su Age of Empires IV", {
          streamer: key,
          gameName: anyLiveStream.game_name || null,
        });
      }
    }

    for (const login of currentlyLive) {
      logger.debug("Streamer Twitch attualmente live", { login });
    }
  } finally {
    pollInFlight = false;
  }
}

function startTwitchMonitor(client) {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !DISCORD_LIVE_CHANNEL_ID) {
    console.log("Monitor Twitch disattivato: mancano variabili ambiente.");
    return;
  }

  ensureMonitorStore().catch((error) => {
    logger.error("Errore inizializzazione monitor store", { message: error.message });
  });

  logger.info("Monitor Twitch attivo", {
    intervalMs: TWITCH_POLL_INTERVAL_MS,
    debugEnabled: logger.enabled(),
  });

  pollTwitchLives(client).catch((error) => {
    logger.error("Errore poll iniziale Twitch", { message: error.message });
  });

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
  loadTwitchSubscriptions,
  addTwitchSubscriptionByInput,
  removeTwitchSubscriptionByInput,
  formatTwitchSubscription,
};
