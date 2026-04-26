const { createLogger } = require("./debug");
const {
  ensureMonitorStore,
  loadYoutubeSubscriptions,
  upsertYoutubeSubscription,
  removeYoutubeSubscription,
} = require("./monitorStore");

const DISCORD_YOUTUBE_CHANNEL_ID = process.env.DISCORD_YOUTUBE_CHANNEL_ID;
const YOUTUBE_POLL_INTERVAL_MS = Number(process.env.YOUTUBE_POLL_INTERVAL_MS || 5 * 60 * 1000);
const AGERS_ROLE_NAME = "Agers";
const logger = createLogger("youtube");

let pollInFlight = false;

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url, errorPrefix, options = {}) {
  logger.debug("HTTP request", {
    url,
    method: options.method || "GET",
  });

  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }

  return response.text();
}

function extractFirstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

function parseYoutubeFeedEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match = null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const videoId = extractFirstMatch(block, /<yt:videoId>([^<]+)<\/yt:videoId>/i);
    const title = decodeXmlEntities(extractFirstMatch(block, /<title>([\s\S]*?)<\/title>/i));
    const url =
      extractFirstMatch(block, /<link[^>]+href="([^"]+)"/i) ||
      (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
    const publishedAt = extractFirstMatch(block, /<published>([^<]+)<\/published>/i);
    const channelTitle = decodeXmlEntities(
      extractFirstMatch(block, /<author>\s*<name>([\s\S]*?)<\/name>/i)
    );

    if (!videoId || !url) {
      continue;
    }

    entries.push({
      videoId,
      title: title || "Nuovo video",
      url,
      publishedAt,
      channelTitle: channelTitle || "Canale YouTube",
    });
  }

  return entries;
}

async function fetchYoutubeFeed(channelId) {
  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    "Errore feed YouTube"
  );

  return parseYoutubeFeedEntries(xml);
}

function extractChannelIdFromUrl(input) {
  try {
    const parsed = new URL(input);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const channelIndex = parts.findIndex((part) => part.toLowerCase() === "channel");

    if (channelIndex >= 0 && parts[channelIndex + 1]) {
      return parts[channelIndex + 1];
    }
  } catch (error) {
    return null;
  }

  return null;
}

function normalizeYoutubeInput(input) {
  const value = String(input || "").trim();

  if (!value) {
    throw new Error("Inserisci un canale YouTube valido.");
  }

  if (/^UC[\w-]{20,}$/i.test(value)) {
    return {
      type: "channelId",
      value,
      url: `https://www.youtube.com/channel/${value}`,
    };
  }

  if (/^https?:\/\//i.test(value)) {
    return {
      type: "url",
      value,
      url: value,
    };
  }

  if (value.startsWith("@")) {
    return {
      type: "handle",
      value,
      url: `https://www.youtube.com/${value}`,
    };
  }

  if (!/\s/.test(value)) {
    return {
      type: "handle",
      value: `@${value.replace(/^@/, "")}`,
      url: `https://www.youtube.com/@${value.replace(/^@/, "")}`,
    };
  }

  throw new Error("Usa un link del canale, un handle tipo @nome, oppure il channel ID.");
}

async function resolveYoutubeChannel(input) {
  const normalized = normalizeYoutubeInput(input);
  const directChannelId =
    normalized.type === "channelId" ? normalized.value : extractChannelIdFromUrl(normalized.url);

  let channelId = directChannelId;
  let canonicalUrl = normalized.url;

  if (!channelId) {
    const html = await fetchText(normalized.url, "Errore pagina YouTube", {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    channelId =
      extractFirstMatch(html, /"channelId":"(UC[\w-]+)"/i) ||
      extractFirstMatch(html, /"externalId":"(UC[\w-]+)"/i) ||
      extractFirstMatch(html, /https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)/i);

    const extractedCanonicalUrl =
      extractFirstMatch(html, /<link rel="canonical" href="([^"]+)"/i) ||
      extractFirstMatch(html, /"canonicalBaseUrl":"([^"]+)"/i);

    if (extractedCanonicalUrl) {
      canonicalUrl = extractedCanonicalUrl.startsWith("http")
        ? extractedCanonicalUrl
        : `https://www.youtube.com${extractedCanonicalUrl}`;
    }
  }

  if (!channelId) {
    throw new Error("Non sono riuscito a ricavare il channel ID da quel canale YouTube.");
  }

  const entries = await fetchYoutubeFeed(channelId);
  const channelTitle = entries[0]?.channelTitle || normalized.value;

  return {
    input: String(input).trim(),
    channelId,
    title: channelTitle,
    url: canonicalUrl || `https://www.youtube.com/channel/${channelId}`,
    latestVideoId: entries[0]?.videoId || null,
  };
}

function formatYoutubeSubscription(subscription) {
  return `- **${subscription.title}** - ${subscription.url} - ID \`${subscription.channelId}\``;
}

function findYoutubeSubscriptionByText(subscriptions, query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();

  if (!normalizedQuery) {
    return null;
  }

  const exact = subscriptions.find((subscription) => {
    return [subscription.channelId, subscription.input, subscription.url, subscription.title]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === normalizedQuery);
  });

  if (exact) {
    return exact;
  }

  const partialMatches = subscriptions.filter((subscription) =>
    String(subscription.title || "")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    throw new Error("Ho trovato piu canali con quel nome. Usa il link completo o il channel ID.");
  }

  return null;
}

async function addYoutubeSubscriptionByInput(input) {
  await ensureMonitorStore();

  const resolved = await resolveYoutubeChannel(input);
  const existing = (await loadYoutubeSubscriptions()).find(
    (subscription) =>
      String(subscription.channelId).toLowerCase() === String(resolved.channelId).toLowerCase()
  );

  const subscription = await upsertYoutubeSubscription({
    channelId: resolved.channelId,
    title: resolved.title,
    url: resolved.url,
    input: String(input).trim(),
    lastVideoId: existing?.lastVideoId || resolved.latestVideoId || null,
    addedAt: existing?.addedAt || new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  });

  return {
    subscription,
    alreadyExists: Boolean(existing),
  };
}

async function removeYoutubeSubscriptionByInput(input) {
  await ensureMonitorStore();

  const subscriptions = await loadYoutubeSubscriptions();
  let match = findYoutubeSubscriptionByText(subscriptions, input);

  if (!match) {
    try {
      const resolved = await resolveYoutubeChannel(input);
      match = subscriptions.find(
        (subscription) =>
          String(subscription.channelId).toLowerCase() === String(resolved.channelId).toLowerCase()
      );
    } catch (error) {
      logger.debug("Risoluzione canale fallita durante remove", {
        input,
        message: error.message,
      });
    }
  }

  if (!match) {
    return null;
  }

  return await removeYoutubeSubscription(match.channelId);
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

function buildYoutubeNotification(subscription, video, roleMention = "") {
  const prefix = roleMention ? `${roleMention}\n` : "";
  return `${prefix}**${subscription.title} ha pubblicato un nuovo video!**\n${video.url}`;
}

async function notifyDiscordYoutubeVideo(client, subscription, video) {
  const channel = await client.channels.fetch(DISCORD_YOUTUBE_CHANNEL_ID);
  const roleMention = await getAgersRoleMention(channel);

  logger.info("Invio messaggio YouTube", {
    channelId: subscription.channelId,
    title: subscription.title,
    videoId: video.videoId,
    discordChannelId: channel?.id || null,
    pingAgers: Boolean(roleMention),
  });

  await channel.send({
    content: buildYoutubeNotification(subscription, video, roleMention),
  });
}

async function pollYoutubeUploads(client) {
  if (pollInFlight) {
    logger.warn("Poll YouTube saltato: controllo precedente ancora in corso");
    return;
  }

  pollInFlight = true;

  try {
    const subscriptions = loadYoutubeSubscriptions();

    if (!subscriptions.length) {
      logger.debug("Nessun canale YouTube configurato");
      return;
    }

    logger.debug("Poll YouTube avviato", {
      monitored: subscriptions.map((subscription) => subscription.channelId),
    });

    for (const subscription of subscriptions) {
      try {
        const entries = await fetchYoutubeFeed(subscription.channelId);

        if (!entries.length) {
          logger.warn("Feed YouTube vuoto", {
            channelId: subscription.channelId,
            title: subscription.title,
          });
          continue;
        }

        const latestEntry = entries[0];
        const knownVideoId = subscription.lastVideoId || null;

        if (!knownVideoId) {
          await upsertYoutubeSubscription({
            ...subscription,
            title: latestEntry.channelTitle || subscription.title,
            lastVideoId: latestEntry.videoId,
            lastCheckedAt: new Date().toISOString(),
          });
          continue;
        }

        if (knownVideoId === latestEntry.videoId) {
          await upsertYoutubeSubscription({
            ...subscription,
            title: latestEntry.channelTitle || subscription.title,
            lastCheckedAt: new Date().toISOString(),
          });
          continue;
        }

        const newEntries = [];

        for (const entry of entries) {
          if (entry.videoId === knownVideoId) {
            break;
          }

          newEntries.push(entry);
        }

        const entriesToNotify = newEntries.length ? [...newEntries].reverse() : [latestEntry];

        for (const entry of entriesToNotify) {
          await notifyDiscordYoutubeVideo(
            client,
            {
              ...subscription,
              title: entry.channelTitle || subscription.title,
            },
            entry
          );
        }

        await upsertYoutubeSubscription({
          ...subscription,
          title: latestEntry.channelTitle || subscription.title,
          lastVideoId: latestEntry.videoId,
          lastCheckedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Errore controllo canale YouTube", {
          channelId: subscription.channelId,
          title: subscription.title,
          message: error.message,
        });
      }
    }
  } finally {
    pollInFlight = false;
  }
}

function startYoutubeMonitor(client) {
  ensureMonitorStore().catch((error) => {
    logger.error("Errore inizializzazione monitor store", { message: error.message });
  });

  if (!DISCORD_YOUTUBE_CHANNEL_ID) {
    logger.warn("Monitor YouTube disattivato: manca DISCORD_YOUTUBE_CHANNEL_ID.");
    return;
  }

  logger.info("Monitor YouTube attivo", {
    intervalMs: YOUTUBE_POLL_INTERVAL_MS,
    discordChannelId: DISCORD_YOUTUBE_CHANNEL_ID,
    debugEnabled: logger.enabled(),
  });

  pollYoutubeUploads(client).catch((error) => {
    logger.error("Errore poll iniziale YouTube", { message: error.message });
  });

  setInterval(async () => {
    try {
      await pollYoutubeUploads(client);
    } catch (error) {
      logger.error("Errore controllo YouTube", { message: error.message });
    }
  }, YOUTUBE_POLL_INTERVAL_MS);
}

module.exports = {
  loadYoutubeSubscriptions,
  addYoutubeSubscriptionByInput,
  removeYoutubeSubscriptionByInput,
  formatYoutubeSubscription,
  startYoutubeMonitor,
};
