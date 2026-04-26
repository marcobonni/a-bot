const { createLogger } = require("./debug");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ACTIVITY_TABLE = process.env.SUPABASE_ACTIVITY_TABLE || "activity_points";
const SUPABASE_ACTIVITY_VOICE_SESSIONS_TABLE =
  process.env.SUPABASE_ACTIVITY_VOICE_SESSIONS_TABLE || "activity_voice_sessions";
const logger = createLogger("activityStore");

const VOICE_INTERVAL_MINUTES = Number(process.env.POINTS_VOICE_INTERVAL_MINUTES || 10);
const VOICE_POINTS_PER_INTERVAL = Number(process.env.POINTS_VOICE_PER_INTERVAL || 1);
const MESSAGE_POINTS = Number(process.env.POINTS_MESSAGE_VALUE || 0.1);
const VOICE_INTERVAL_MS = VOICE_INTERVAL_MINUTES * 60 * 1000;

const runtimeState = {
  users: {},
  activeVoiceSessions: {},
};

let supabaseClient = null;
let storeReady = false;

function roundPoints(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
    throw new Error("Supabase non configurato: per questo bot i salvataggi devono andare su DB.");
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

function ensureRuntimeUser(userId) {
  const key = String(userId);

  if (!runtimeState.users[key]) {
    runtimeState.users[key] = {
      discordName: null,
      points: 0,
      messageCount: 0,
      voiceMs: 0,
      voiceSessions: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  return runtimeState.users[key];
}

function mapRowToUser(row) {
  return {
    discordName: row.discord_name || null,
    points: Number(row.points || 0),
    messageCount: Number(row.message_count || 0),
    voiceMs: Number(row.voice_ms || 0),
    voiceSessions: Number(row.voice_sessions || 0),
    updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
  };
}

function mapRowToSession(row) {
  return {
    channelId: row.channel_id ? String(row.channel_id) : null,
    startedAt: row.started_at,
  };
}

async function ensureUserRecord(userId, discordName = null) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(SUPABASE_ACTIVITY_TABLE)
    .upsert(
      {
        discord_user_id: String(userId),
        discord_name: discordName || null,
        points: 0,
        message_count: 0,
        voice_ms: 0,
        voice_sessions: 0,
      },
      { onConflict: "discord_user_id" }
    )
    .select(
      "discord_user_id, discord_name, points, message_count, voice_ms, voice_sessions, created_at, updated_at"
    )
    .single();

  if (error) {
    throw new Error(`Errore creazione record activity points: ${error.message}`);
  }

  runtimeState.users[String(userId)] = mapRowToUser(data);
  return runtimeState.users[String(userId)];
}

function getActiveVoiceMs(userId, now = Date.now()) {
  const session = runtimeState.activeVoiceSessions[String(userId)];

  if (!session?.startedAt) {
    return 0;
  }

  return Math.max(0, now - new Date(session.startedAt).getTime());
}

function calculateVoicePoints(voiceMs) {
  if (!voiceMs || voiceMs <= 0) {
    return 0;
  }

  return roundPoints((voiceMs / VOICE_INTERVAL_MS) * VOICE_POINTS_PER_INTERVAL);
}

async function loadUsersFromSupabase() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(SUPABASE_ACTIVITY_TABLE)
    .select(
      "discord_user_id, discord_name, points, message_count, voice_ms, voice_sessions, created_at, updated_at"
    );

  if (error) {
    throw new Error(`Errore lettura Supabase activity points: ${error.message}`);
  }

  runtimeState.users = {};
  for (const row of data || []) {
    runtimeState.users[String(row.discord_user_id)] = mapRowToUser(row);
  }
}

async function loadVoiceSessionsFromSupabase() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(SUPABASE_ACTIVITY_VOICE_SESSIONS_TABLE)
    .select("discord_user_id, channel_id, started_at");

  if (error) {
    throw new Error(`Errore lettura Supabase activity voice sessions: ${error.message}`);
  }

  runtimeState.activeVoiceSessions = {};
  for (const row of data || []) {
    runtimeState.activeVoiceSessions[String(row.discord_user_id)] = mapRowToSession(row);
  }
}

function unwrapRpcRow(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }

  return data || null;
}

async function ensureActivityStore() {
  if (storeReady) {
    return;
  }

  getSupabaseClient();
  await loadUsersFromSupabase();
  await loadVoiceSessionsFromSupabase();
  storeReady = true;

  logger.info("Activity store pronto", {
    users: Object.keys(runtimeState.users).length,
    activeVoiceSessions: Object.keys(runtimeState.activeVoiceSessions).length,
    table: SUPABASE_ACTIVITY_TABLE,
    sessionsTable: SUPABASE_ACTIVITY_VOICE_SESSIONS_TABLE,
  });
}

async function addMessagePoints(userId, discordName = null) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("increment_activity_message", {
    p_user_id: String(userId),
    p_discord_name: discordName || null,
    p_points: MESSAGE_POINTS,
  });

  if (error) {
    throw new Error(`Errore incremento punti messaggio: ${error.message}`);
  }

  const row = unwrapRpcRow(data);
  if (!row) {
    throw new Error("Incremento punti messaggio completato senza riga di risposta.");
  }

  runtimeState.users[String(userId)] = mapRowToUser(row);
  return getUserStats(userId);
}

async function startVoiceSession(userId, channelId, discordName = null, startedAt = Date.now()) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("start_activity_voice_session", {
    p_user_id: String(userId),
    p_channel_id: channelId ? String(channelId) : null,
    p_started_at: new Date(startedAt).toISOString(),
  });

  if (error) {
    throw new Error(`Errore apertura sessione vocale: ${error.message}`);
  }

  const row = unwrapRpcRow(data);
  if (!row) {
    throw new Error("Apertura sessione vocale completata senza riga di risposta.");
  }

  runtimeState.activeVoiceSessions[String(userId)] = mapRowToSession(row);
  await ensureUserRecord(userId, discordName);
  return runtimeState.activeVoiceSessions[String(userId)];
}

async function endVoiceSession(userId, endedAt = Date.now()) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("close_activity_voice_session", {
    p_user_id: String(userId),
    p_ended_at: new Date(endedAt).toISOString(),
    p_interval_minutes: VOICE_INTERVAL_MINUTES,
    p_points_per_interval: VOICE_POINTS_PER_INTERVAL,
  });

  if (error) {
    throw new Error(`Errore chiusura sessione vocale: ${error.message}`);
  }

  const row = unwrapRpcRow(data);
  delete runtimeState.activeVoiceSessions[String(userId)];

  if (!row) {
    return null;
  }

  runtimeState.users[String(userId)] = mapRowToUser(row);

  return {
    durationMs: Number(row.duration_ms || 0),
    pointsEarned: Number(row.points_earned || 0),
    stats: getUserStats(userId),
  };
}

async function reconcileActiveVoiceSessions(activeVoiceEntries) {
  const now = Date.now();
  const actualMap = new Map(activeVoiceEntries.map((entry) => [String(entry.userId), entry]));

  for (const userId of Object.keys(runtimeState.activeVoiceSessions)) {
    if (!actualMap.has(userId)) {
      await endVoiceSession(userId, now);
    }
  }

  for (const [userId, entry] of actualMap.entries()) {
    const channelId = String(entry.channelId);
    const existingSession = runtimeState.activeVoiceSessions[userId];

    if (!existingSession) {
      await startVoiceSession(userId, channelId, entry.discordName || null, now);
      continue;
    }

    if (existingSession.channelId !== channelId) {
      await startVoiceSession(
        userId,
        channelId,
        entry.discordName || null,
        new Date(existingSession.startedAt).getTime()
      );
      continue;
    }

    await ensureUserRecord(userId, entry.discordName || null);
  }
}

function getUserStats(userId) {
  const user = ensureRuntimeUser(userId);
  const activeVoiceMs = getActiveVoiceMs(userId);
  const totalVoiceMs = user.voiceMs + activeVoiceMs;

  return {
    userId: String(userId),
    points: roundPoints(user.points + calculateVoicePoints(activeVoiceMs)),
    messageCount: user.messageCount,
    voiceMs: totalVoiceMs,
    voiceMinutes: Math.floor(totalVoiceMs / 60000),
    voiceSessions: user.voiceSessions,
    updatedAt: user.updatedAt,
    activeVoiceSession: runtimeState.activeVoiceSessions[String(userId)] || null,
  };
}

function getLeaderboard(limit = 10) {
  return Object.entries(runtimeState.users)
    .map(([userId, entry]) => {
      const activeVoiceMs = getActiveVoiceMs(userId);
      const totalVoiceMs = entry.voiceMs + activeVoiceMs;

      return {
        userId,
        points: roundPoints(entry.points + calculateVoicePoints(activeVoiceMs)),
        messageCount: entry.messageCount || 0,
        voiceMinutes: Math.floor(totalVoiceMs / 60000),
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) {
        return b.points - a.points;
      }

      return b.voiceMinutes - a.voiceMinutes;
    })
    .slice(0, limit);
}

module.exports = {
  MESSAGE_POINTS,
  VOICE_INTERVAL_MINUTES,
  VOICE_POINTS_PER_INTERVAL,
  addMessagePoints,
  endVoiceSession,
  ensureActivityStore,
  getLeaderboard,
  getUserStats,
  reconcileActiveVoiceSessions,
  startVoiceSession,
};
