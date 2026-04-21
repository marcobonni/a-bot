const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "links.json");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_PLAYERS_TABLE = process.env.SUPABASE_PLAYERS_TABLE || "rank_links";

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function ensureLocalDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

function loadLocalLinks() {
  ensureLocalDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveLocalLinks(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function hasLocalLinksToMigrate() {
  if (!fs.existsSync(DATA_FILE)) {
    return false;
  }

  const data = loadLocalLinks();
  return Object.keys(data).length > 0;
}

let supabaseClient = null;

function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
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

function mapRowToEntry(row) {
  return {
    profileId: row.profile_id,
    playerName: row.player_name,
    linkedAt: row.linked_at,
    lastSoloRank: row.last_solo_rank,
    lastTeamRank: row.last_team_rank,
  };
}

function mapEntryToRow(discordUserId, entry) {
  return {
    discord_user_id: String(discordUserId),
    profile_id: entry.profileId ? String(entry.profileId) : null,
    player_name: entry.playerName || null,
    linked_at: entry.linkedAt || new Date().toISOString(),
    last_solo_rank: entry.lastSoloRank || null,
    last_team_rank: entry.lastTeamRank || null,
  };
}

async function ensureRankStore() {
  if (hasSupabaseConfig()) {
    console.log(`[rankStore] Supabase attivo, tabella: ${SUPABASE_PLAYERS_TABLE}`);
    if (hasLocalLinksToMigrate()) {
      console.log("[rankStore] Trovato links.json locale: provo migrazione verso Supabase.");
      const localLinks = loadLocalLinks();
      for (const [discordUserId, entry] of Object.entries(localLinks)) {
        await upsertRankLink(discordUserId, entry);
      }
      console.log("[rankStore] Migrazione locale -> Supabase completata.");
    }
    return;
  }

  ensureLocalDataFile();
  console.warn("[rankStore] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY mancanti: uso links.json locale.");
}

async function loadRankLinks() {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return loadLocalLinks();
  }

  const { data, error } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .select("discord_user_id, profile_id, player_name, linked_at, last_solo_rank, last_team_rank");

  if (error) {
    throw new Error(`Errore lettura Supabase rank links: ${error.message}`);
  }

  const links = {};
  for (const row of data || []) {
    links[row.discord_user_id] = mapRowToEntry(row);
  }

  return links;
}

async function saveRankLinks(data) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    saveLocalLinks(data);
    return;
  }

  const rows = Object.entries(data).map(([discordUserId, entry]) =>
    mapEntryToRow(discordUserId, entry)
  );

  if (rows.length === 0) {
    const { error } = await supabase.from(SUPABASE_PLAYERS_TABLE).delete().neq("discord_user_id", "");
    if (error) {
      throw new Error(`Errore pulizia Supabase rank links: ${error.message}`);
    }
    return;
  }

  const { error: upsertError } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .upsert(rows, { onConflict: "discord_user_id" });

  if (upsertError) {
    throw new Error(`Errore salvataggio Supabase rank links: ${upsertError.message}`);
  }

  const ids = rows.map((row) => row.discord_user_id);
  const { error: deleteError } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .delete()
    .not("discord_user_id", "in", `(${ids.map((id) => JSON.stringify(id)).join(",")})`);

  if (deleteError) {
    throw new Error(`Errore sincronizzazione eliminazioni Supabase: ${deleteError.message}`);
  }
}

async function upsertRankLink(discordUserId, entry) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    const links = loadLocalLinks();
    links[String(discordUserId)] = {
      profileId: entry.profileId ? String(entry.profileId) : null,
      playerName: entry.playerName || null,
      linkedAt: entry.linkedAt || new Date().toISOString(),
      lastSoloRank: entry.lastSoloRank || null,
      lastTeamRank: entry.lastTeamRank || null,
    };
    saveLocalLinks(links);
    return links[String(discordUserId)];
  }

  const row = mapEntryToRow(discordUserId, entry);
  const { data, error } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .upsert(row, { onConflict: "discord_user_id" })
    .select("discord_user_id, profile_id, player_name, linked_at, last_solo_rank, last_team_rank")
    .single();

  if (error) {
    throw new Error(`Errore upsert Supabase rank link: ${error.message}`);
  }

  return mapRowToEntry(data);
}

async function deleteRankLink(discordUserId) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    const links = loadLocalLinks();
    delete links[String(discordUserId)];
    saveLocalLinks(links);
    return;
  }

  const { error } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .delete()
    .eq("discord_user_id", String(discordUserId));

  if (error) {
    throw new Error(`Errore delete Supabase rank link: ${error.message}`);
  }
}

async function updateRankSnapshot(discordUserId, snapshot) {
  const supabase = getSupabaseClient();

  if (!supabase) {
    const links = loadLocalLinks();
    if (!links[String(discordUserId)]) {
      return;
    }

    links[String(discordUserId)].lastSoloRank = snapshot.lastSoloRank || null;
    links[String(discordUserId)].lastTeamRank = snapshot.lastTeamRank || null;
    saveLocalLinks(links);
    return;
  }

  const { error } = await supabase
    .from(SUPABASE_PLAYERS_TABLE)
    .update({
      last_solo_rank: snapshot.lastSoloRank || null,
      last_team_rank: snapshot.lastTeamRank || null,
    })
    .eq("discord_user_id", String(discordUserId));

  if (error) {
    throw new Error(`Errore update rank snapshot Supabase: ${error.message}`);
  }
}

module.exports = {
  ensureRankStore,
  loadRankLinks,
  saveRankLinks,
  upsertRankLink,
  deleteRankLink,
  updateRankSnapshot,
};
