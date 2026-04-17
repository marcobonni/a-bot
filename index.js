const {
  ActionRowBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Mancano DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID o DISCORD_GUILD_ID nelle variabili ambiente."
  );
}

const DATA_FILE = path.join(__dirname, "links.json");
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const SEARCH_MENU_PREFIX = "select_player:";

const SOLO_ROLE_MAP = {
  bronze: process.env.ROLE_SOLO_BRONZE,
  silver: process.env.ROLE_SOLO_SILVER,
  gold: process.env.ROLE_SOLO_GOLD,
  platinum: process.env.ROLE_SOLO_PLATINUM,
  diamond: process.env.ROLE_SOLO_DIAMOND,
  conqueror: process.env.ROLE_SOLO_CONQUEROR,
};

const TEAM_ROLE_MAP = {
  bronze: process.env.ROLE_TEAM_BRONZE,
  silver: process.env.ROLE_TEAM_SILVER,
  gold: process.env.ROLE_TEAM_GOLD,
  platinum: process.env.ROLE_TEAM_PLATINUM,
  diamond: process.env.ROLE_TEAM_DIAMOND,
  conqueror: process.env.ROLE_TEAM_CONQUEROR,
};

const SOLO_ROLE_IDS = Object.values(SOLO_ROLE_MAP).filter(Boolean);
const TEAM_ROLE_IDS = Object.values(TEAM_ROLE_MAP).filter(Boolean);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

function loadLinks() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveLinks(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function normalizeRankLevel(rankLevel) {
  if (!rankLevel) return null;

  const value = String(rankLevel).trim().toLowerCase();

  if (value.includes("conqueror")) return "conqueror";
  if (value.includes("diamond")) return "diamond";
  if (value.includes("platinum")) return "platinum";
  if (value.includes("gold")) return "gold";
  if (value.includes("silver")) return "silver";
  if (value.includes("bronze")) return "bronze";

  return null;
}

async function fetchJson(url, errorPrefix) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }

  return response.json();
}

async function fetchPlayerProfile(profileId) {
  const url = `https://aoe4world.com/api/v0/players/${encodeURIComponent(profileId)}`;
  return fetchJson(url, "Errore recupero profilo AoE4World");
}

async function searchPlayers(query) {
  const url = `https://aoe4world.com/api/v0/players/search?query=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, "Errore ricerca giocatori AoE4World");

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.players)) return data.players;
  if (Array.isArray(data?.items)) return data.items;

  return [];
}

async function fetchLeaderboardEntry(leaderboard, profileId) {
  const url = `https://aoe4world.com/api/v0/leaderboards/${leaderboard}?profile_id=${encodeURIComponent(profileId)}`;
  const data = await fetchJson(url, `Errore leaderboard ${leaderboard}`);

  if (Array.isArray(data)) {
    return data[0] || null;
  }

  if (Array.isArray(data?.players)) {
    return data.players[0] || null;
  }

  if (Array.isArray(data?.leaderboard)) {
    return data.leaderboard[0] || null;
  }

  if (Array.isArray(data?.entries)) {
    return data.entries[0] || null;
  }

  if (Array.isArray(data?.items)) {
    return data.items[0] || null;
  }

  if (data?.profile_id || data?.rank_level || data?.rating) {
    return data;
  }

  return null;
}

async function getRankSnapshot(profileId) {
  const [soloEntry, teamEntry] = await Promise.all([
    fetchLeaderboardEntry("rm_solo", profileId),
    fetchLeaderboardEntry("rm_team", profileId),
  ]);

  return {
    solo: {
      rank: normalizeRankLevel(soloEntry?.rank_level),
      rating: soloEntry?.rating ?? null,
      raw: soloEntry ?? null,
    },
    team: {
      rank: normalizeRankLevel(teamEntry?.rank_level),
      rating: teamEntry?.rating ?? null,
      raw: teamEntry ?? null,
    },
  };
}

async function removeRankFamily(member, roleIdsToRemove, roleIdToKeep = null) {
  const toRemove = roleIdsToRemove.filter(
    (roleId) => roleId && roleId !== roleIdToKeep && member.roles.cache.has(roleId)
  );

  if (toRemove.length > 0) {
    await member.roles.remove(toRemove, "Aggiornamento automatico rank AoE4");
  }
}

async function ensureRankRole(member, roleId) {
  if (!roleId) return;
  if (!member.roles.cache.has(roleId)) {
    await member.roles.add(roleId, "Aggiornamento automatico rank AoE4");
  }
}

async function syncMemberRoles(guild, discordUserId, linkEntry) {
  const member = await guild.members.fetch(discordUserId);
  const snapshot = await getRankSnapshot(linkEntry.profileId);

  const soloRoleId = snapshot.solo.rank ? SOLO_ROLE_MAP[snapshot.solo.rank] : null;
  const teamRoleId = snapshot.team.rank ? TEAM_ROLE_MAP[snapshot.team.rank] : null;

  await removeRankFamily(member, SOLO_ROLE_IDS, soloRoleId);
  await removeRankFamily(member, TEAM_ROLE_IDS, teamRoleId);

  if (soloRoleId) {
    await ensureRankRole(member, soloRoleId);
  }

  if (teamRoleId) {
    await ensureRankRole(member, teamRoleId);
  }

  return snapshot;
}

function getVoiceMemberIds(guild) {
  const ids = new Set();

  for (const [, channel] of guild.channels.cache) {
    if (
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice
    ) {
      for (const [memberId] of channel.members) {
        ids.add(memberId);
      }
    }
  }

  return ids;
}

async function syncOnlyVoiceUsers(guild) {
  await guild.channels.fetch();
  await guild.members.fetch();

  const links = loadLinks();
  const voiceMemberIds = getVoiceMemberIds(guild);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const memberId of voiceMemberIds) {
    processed += 1;

    const linkEntry = links[memberId];
    if (!linkEntry?.profileId) {
      skipped += 1;
      continue;
    }

    try {
      await syncMemberRoles(guild, memberId, linkEntry);
      updated += 1;
    } catch (error) {
      errors += 1;
      console.error(`Errore sync utente ${memberId}:`, error.message);
    }
  }

  return { processed, updated, skipped, errors };
}

function formatSnapshot(snapshot) {
  return [
    `Solo: **${snapshot.solo.rank || "non classificato"}**${
      snapshot.solo.rating ? ` (${snapshot.solo.rating})` : ""
    }`,
    `Team: **${snapshot.team.rank || "non classificato"}**${
      snapshot.team.rating ? ` (${snapshot.team.rating})` : ""
    }`,
  ].join("\n");
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("link")
      .setDescription("Collega il tuo profilo AoE4 tramite profile ID")
      .addStringOption((option) =>
        option
          .setName("profile_id")
          .setDescription("Il tuo profile ID AoE4World")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("linkname")
      .setDescription("Collega il tuo profilo AoE4 usando il nome Steam/AoE4")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Nome Steam o nome giocatore")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Scollega il tuo profilo AoE4World"),

    new SlashCommandBuilder()
      .setName("syncme")
      .setDescription("Aggiorna subito i tuoi ruoli AoE4"),

    new SlashCommandBuilder()
      .setName("syncvoice")
      .setDescription("Aggiorna i ruoli AoE4 degli utenti attualmente in vocale")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
}

client.once("ready", async () => {
  console.log(`Bot online come ${client.user.tag}`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const fullGuild = await guild.fetch();

    const result = await syncOnlyVoiceUsers(fullGuild);
    console.log("Sync iniziale completato:", result);

    setInterval(async () => {
      try {
        const hourlyResult = await syncOnlyVoiceUsers(fullGuild);
        console.log("Sync orario completato:", hourlyResult);
      } catch (error) {
        console.error("Errore sync orario:", error);
      }
    }, SYNC_INTERVAL_MS);
  } catch (error) {
    console.error("Errore nel bootstrap del bot:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isStringSelectMenu()) {
      if (!interaction.customId.startsWith(SEARCH_MENU_PREFIX)) {
        return;
      }

      const requesterId = interaction.customId.slice(SEARCH_MENU_PREFIX.length);

      if (interaction.user.id !== requesterId) {
        await interaction.reply({
          content: "Questo menu non è destinato a te.",
          ephemeral: true,
        });
        return;
      }

      const profileId = interaction.values[0];
      const player = await fetchPlayerProfile(profileId);

      const links = loadLinks();
      links[interaction.user.id] = {
        profileId: String(profileId),
        playerName: player?.name || null,
        linkedAt: new Date().toISOString(),
      };
      saveLinks(links);

      const snapshot = await syncMemberRoles(
        interaction.guild,
        interaction.user.id,
        links[interaction.user.id]
      );

      await interaction.update({
        content: [
          `Profilo collegato: **${player?.name || "Sconosciuto"}** (${profileId})`,
          formatSnapshot(snapshot),
        ].join("\n"),
        components: [],
      });
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "link") {
      await interaction.deferReply({ ephemeral: true });

      const profileId = interaction.options.getString("profile_id", true).trim();
      const player = await fetchPlayerProfile(profileId);

      const links = loadLinks();
      links[interaction.user.id] = {
        profileId,
        playerName: player?.name || null,
        linkedAt: new Date().toISOString(),
      };
      saveLinks(links);

      const snapshot = await syncMemberRoles(
        interaction.guild,
        interaction.user.id,
        links[interaction.user.id]
      );

      await interaction.editReply(
        [
          `Profilo collegato: **${player?.name || "Sconosciuto"}** (${profileId})`,
          formatSnapshot(snapshot),
        ].join("\n")
      );
      return;
    }

    if (interaction.commandName === "linkname") {
      await interaction.deferReply({ ephemeral: true });

      const query = interaction.options.getString("name", true).trim();
      const results = await searchPlayers(query);

      if (!results.length) {
        await interaction.editReply("Nessun giocatore trovato con quel nome.");
        return;
      }

      if (results.length === 1) {
        const player = results[0];
        const profileId = String(player.profile_id || player.id || "");

        if (!profileId) {
          throw new Error("Il risultato trovato non contiene un profile ID valido.");
        }

        const playerProfile = await fetchPlayerProfile(profileId);

        const links = loadLinks();
        links[interaction.user.id] = {
          profileId,
          playerName: playerProfile?.name || player?.name || null,
          linkedAt: new Date().toISOString(),
        };
        saveLinks(links);

        const snapshot = await syncMemberRoles(
          interaction.guild,
          interaction.user.id,
          links[interaction.user.id]
        );

        await interaction.editReply(
          [
            `Profilo collegato automaticamente: **${playerProfile?.name || player?.name || "Sconosciuto"}** (${profileId})`,
            formatSnapshot(snapshot),
          ].join("\n")
        );
        return;
      }

      const options = results
        .slice(0, 25)
        .map((player, index) => {
          const profileId = String(player.profile_id || player.id || "");
          const playerName = String(player.name || `Giocatore ${index + 1}`).slice(0, 100);
          const country = player.country ? ` | ${player.country}` : "";
          const description = `ID: ${profileId}${country}`.slice(0, 100);

          return {
            label: playerName,
            description,
            value: profileId,
          };
        })
        .filter((option) => option.value);

      if (!options.length) {
        await interaction.editReply("Ho trovato risultati, ma nessuno con profile ID valido.");
        return;
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${SEARCH_MENU_PREFIX}${interaction.user.id}`)
        .setPlaceholder("Scegli il tuo profilo AoE4")
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(menu);

      await interaction.editReply({
        content: "Ho trovato più profili. Seleziona quello corretto:",
        components: [row],
      });
      return;
    }

    if (interaction.commandName === "unlink") {
      const links = loadLinks();
      const entry = links[interaction.user.id];

      if (!entry) {
        await interaction.reply({
          content: "Non hai nessun profilo collegato.",
          ephemeral: true,
        });
        return;
      }

      delete links[interaction.user.id];
      saveLinks(links);

      const member = await interaction.guild.members.fetch(interaction.user.id);
      await removeRankFamily(member, SOLO_ROLE_IDS, null);
      await removeRankFamily(member, TEAM_ROLE_IDS, null);

      await interaction.reply({
        content: "Profilo scollegato e ruoli rank rimossi.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "syncme") {
      await interaction.deferReply({ ephemeral: true });

      const links = loadLinks();
      const entry = links[interaction.user.id];

      if (!entry) {
        await interaction.editReply("Non hai ancora collegato un profilo. Usa `/link` o `/linkname`.");
        return;
      }

      const snapshot = await syncMemberRoles(interaction.guild, interaction.user.id, entry);

      await interaction.editReply(
        [`Ruoli aggiornati.`, formatSnapshot(snapshot)].join("\n")
      );
      return;
    }

    if (interaction.commandName === "syncvoice") {
      await interaction.deferReply({ ephemeral: true });

      const result = await syncOnlyVoiceUsers(interaction.guild);

      await interaction.editReply(
        [
          "Sync completato.",
          `Utenti in vocale trovati: **${result.processed}**`,
          `Aggiornati: **${result.updated}**`,
          `Saltati senza profilo collegato: **${result.skipped}**`,
          `Errori: **${result.errors}**`,
        ].join("\n")
      );
    }
  } catch (error) {
    console.error("Errore interaction:", error);

    const message = `Errore: ${error.message}`;

    if (interaction.isRepliable()) {
      if (interaction.deferred) {
        await interaction.editReply(message);
      } else if (interaction.replied) {
        await interaction.followUp({ content: message, ephemeral: true });
      } else {
        await interaction.reply({ content: message, ephemeral: true });
      }
    }
  }
});

registerCommands()
  .then(() => client.login(TOKEN))
  .catch((error) => {
    console.error("Errore avvio bot:", error);
  });