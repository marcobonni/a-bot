const fs = require("fs");
const path = require("path");
const { createLogger } = require("./debug");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const YOUTUBE_TABLE = process.env.SUPABASE_YOUTUBE_CHANNELS_TABLE || "youtube_channels";
const TWITCH_TABLE = process.env.SUPABASE_TWITCH_CHANNELS_TABLE || "twitch_channels";
const YOUTUBE_FILE = path.join(__dirname, "youtubeSubscriptions.json");
const TWITCH_FILE = path.join(__dirname, "twitchSubscriptions.json");
const LEGACY_TWITCH_STREAMERS = (process.env.TWITCH_STREAMERS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const logger = createLogger("monitorStore");

let supabaseClient = null;
let warnedNoSupabase = false;
let monitorStoreEnsured = false;

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
    if (!warnedNoSupabase) {
      logger.warn("Supabase non configurato per i monitor: uso storage locale.");
      warnedNoSupabase = true;
    }
    return null;
  }

  if (!supabaseClient) {
    const { createClient } = require("@supabase/supabase-js");
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return supabaseClient;
}

function ensureLocalFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ subscriptions: [] }, null, 2), "utf8");
  }
}

function loadLocalSubscriptions(filePath) {
  ensureLocalFile(filePath);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
}

function saveLocalSubscriptions(filePath, subscriptions) {
  ensureLocalFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify({ subscriptions }, null, 2), "utf8");
}

async function loadRows(table) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.from(table).select("*").order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Errore lettura Supabase ${table}: ${error.message}`);
  }

  return data || [];
}

async function upsertRow(table, row, conflictColumn) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from(table)
    .upsert(row, { onConflict: conflictColumn })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Errore upsert Supabase ${table}: ${error.message}`);
  }

  return data;
}

async function deleteByColumn(table, column, value) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from(table)
    .delete()
    .eq(column, value)
    .select("*");

  if (error) {
    throw new Error(`Errore delete Supabase ${table}: ${error.message}`);
  }

  return data?.[0] || null;
}

function mapYoutubeRowToSubscription(row) {
  return {
    channelId: row.channel_id,
    title: row.title,
    url: row.url,
    input: row.input_value,
    lastVideoId: row.last_video_id,
    pingAgers: Boolean(row.ping_agers),
    addedAt: row.added_at,
    lastCheckedAt: row.last_checked_at,
  };
}

function mapYoutubeSubscriptionToRow(subscription) {
  return {
    channel_id: String(subscription.channelId),
    title: subscription.title || null,
    url: subscription.url || null,
    input_value: subscription.input || null,
    last_video_id: subscription.lastVideoId || null,
    ping_agers: Boolean(subscription.pingAgers),
    added_at: subscription.addedAt || new Date().toISOString(),
    last_checked_at: subscription.lastCheckedAt || null,
  };
}

function mapTwitchRowToSubscription(row) {
  return {
    login: row.login,
    displayName: row.display_name,
    url: row.url,
    pingAgers: Boolean(row.ping_agers),
    addedAt: row.added_at,
    lastStreamId: row.last_stream_id,
    lastLiveMessageId: row.last_live_message_id,
    lastSeenLiveAt: row.last_seen_live_at,
  };
}

function mapTwitchSubscriptionToRow(subscription) {
  return {
    login: String(subscription.login).toLowerCase(),
    display_name: subscription.displayName || null,
    url: subscription.url || `https://twitch.tv/${String(subscription.login).toLowerCase()}`,
    ping_agers: Boolean(subscription.pingAgers),
    added_at: subscription.addedAt || new Date().toISOString(),
    last_stream_id: subscription.lastStreamId || null,
    last_live_message_id: subscription.lastLiveMessageId || null,
    last_seen_live_at: subscription.lastSeenLiveAt || null,
  };
}

async function migrateYoutubeLocalToSupabase() {
  const supabase = getSupabaseClient();
  if (!supabase || !fs.existsSync(YOUTUBE_FILE)) {
    return;
  }

  const localSubscriptions = loadLocalSubscriptions(YOUTUBE_FILE);
  if (!localSubscriptions.length) {
    return;
  }

  logger.info("Migro canali YouTube locali su Supabase", {
    count: localSubscriptions.length,
  });

  for (const subscription of localSubscriptions) {
    await upsertRow(YOUTUBE_TABLE, mapYoutubeSubscriptionToRow(subscription), "channel_id");
  }
}

async function migrateTwitchEnvToSupabase() {
  const supabase = getSupabaseClient();
  if (!supabase || !LEGACY_TWITCH_STREAMERS.length) {
    return;
  }

  logger.info("Migro streamer Twitch da env a Supabase", {
    count: LEGACY_TWITCH_STREAMERS.length,
  });

  for (const login of LEGACY_TWITCH_STREAMERS) {
    await upsertRow(
      TWITCH_TABLE,
      mapTwitchSubscriptionToRow({
        login,
        displayName: login,
      }),
      "login"
    );
  }
}

async function ensureMonitorStore() {
  if (monitorStoreEnsured) {
    return;
  }

  if (!hasSupabaseConfig()) {
    ensureLocalFile(YOUTUBE_FILE);
    ensureLocalFile(TWITCH_FILE);
    monitorStoreEnsured = true;
    return;
  }

  await migrateYoutubeLocalToSupabase();
  await migrateTwitchEnvToSupabase();
  monitorStoreEnsured = true;
}

async function loadYoutubeSubscriptions() {
  const rows = await loadRows(YOUTUBE_TABLE);

  if (!rows) {
    return loadLocalSubscriptions(YOUTUBE_FILE);
  }

  return rows.map(mapYoutubeRowToSubscription);
}

async function upsertYoutubeSubscription(subscription) {
  const row = mapYoutubeSubscriptionToRow(subscription);
  const saved = await upsertRow(YOUTUBE_TABLE, row, "channel_id");

  if (!saved) {
    const subscriptions = loadLocalSubscriptions(YOUTUBE_FILE);
    const index = subscriptions.findIndex(
      (entry) => String(entry.channelId).toLowerCase() === String(subscription.channelId).toLowerCase()
    );

    if (index >= 0) {
      subscriptions[index] = {
        ...subscriptions[index],
        ...subscription,
      };
    } else {
      subscriptions.push(subscription);
    }

    saveLocalSubscriptions(YOUTUBE_FILE, subscriptions);
    return subscriptions.find(
      (entry) => String(entry.channelId).toLowerCase() === String(subscription.channelId).toLowerCase()
    );
  }

  return mapYoutubeRowToSubscription(saved);
}

async function removeYoutubeSubscription(channelId) {
  const removed = await deleteByColumn(YOUTUBE_TABLE, "channel_id", String(channelId));

  if (!removed) {
    const subscriptions = loadLocalSubscriptions(YOUTUBE_FILE);
    const index = subscriptions.findIndex(
      (entry) => String(entry.channelId).toLowerCase() === String(channelId).toLowerCase()
    );

    if (index < 0) {
      return null;
    }

    const [localRemoved] = subscriptions.splice(index, 1);
    saveLocalSubscriptions(YOUTUBE_FILE, subscriptions);
    return localRemoved;
  }

  return mapYoutubeRowToSubscription(removed);
}

async function loadTwitchSubscriptions() {
  const rows = await loadRows(TWITCH_TABLE);

  if (!rows) {
    const localSubscriptions = loadLocalSubscriptions(TWITCH_FILE);
    if (localSubscriptions.length) {
      return localSubscriptions;
    }

    return LEGACY_TWITCH_STREAMERS.map((login) => ({
      login,
      displayName: login,
      url: `https://twitch.tv/${login}`,
      pingAgers: false,
      addedAt: new Date().toISOString(),
      lastStreamId: null,
      lastLiveMessageId: null,
      lastSeenLiveAt: null,
    }));
  }

  return rows.map(mapTwitchRowToSubscription);
}

async function upsertTwitchSubscription(subscription) {
  const row = mapTwitchSubscriptionToRow(subscription);
  const saved = await upsertRow(TWITCH_TABLE, row, "login");

  if (!saved) {
    const subscriptions = loadLocalSubscriptions(TWITCH_FILE);
    const index = subscriptions.findIndex(
      (entry) => String(entry.login).toLowerCase() === String(subscription.login).toLowerCase()
    );

    if (index >= 0) {
      subscriptions[index] = {
        ...subscriptions[index],
        ...subscription,
      };
    } else {
      subscriptions.push({
        ...subscription,
        login: String(subscription.login).toLowerCase(),
      });
    }

    saveLocalSubscriptions(TWITCH_FILE, subscriptions);
    return subscriptions.find(
      (entry) => String(entry.login).toLowerCase() === String(subscription.login).toLowerCase()
    );
  }

  return mapTwitchRowToSubscription(saved);
}

async function removeTwitchSubscription(login) {
  const normalizedLogin = String(login).toLowerCase();
  const removed = await deleteByColumn(TWITCH_TABLE, "login", normalizedLogin);

  if (!removed) {
    const subscriptions = loadLocalSubscriptions(TWITCH_FILE);
    const index = subscriptions.findIndex(
      (entry) => String(entry.login).toLowerCase() === normalizedLogin
    );

    if (index < 0) {
      return null;
    }

    const [localRemoved] = subscriptions.splice(index, 1);
    saveLocalSubscriptions(TWITCH_FILE, subscriptions);
    return localRemoved;
  }

  return mapTwitchRowToSubscription(removed);
}

module.exports = {
  ensureMonitorStore,
  loadYoutubeSubscriptions,
  upsertYoutubeSubscription,
  removeYoutubeSubscription,
  loadTwitchSubscriptions,
  upsertTwitchSubscription,
  removeTwitchSubscription,
};
