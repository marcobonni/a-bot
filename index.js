const {
  ActionRowBuilder,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");
const { startTwitchMonitor } = require("./twitch");
const { startQueueChannelWebhookServer } = require("./queueChannelSync");
const {
  ensureRankStore,
  loadRankLinks,
  fetchPlayerProfile,
  searchPlayers,
  syncMemberRoles,
  syncOnlyVoiceUsers,
  formatSnapshot,
} = require("./rank");
const { upsertRankLink, deleteRankLink } = require("./rankStore");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Mancano DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID o DISCORD_GUILD_ID nelle variabili ambiente."
  );
}

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const SEARCH_MENU_PREFIX = "select_player:";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

async function registerCommands() {
  console.log("[index] Registrazione comandi slash...");

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

  console.log("[index] Comandi slash registrati con successo");
}

client.once("ready", async () => {
  console.log(`[index] Bot online come ${client.user.tag}`);
  console.log("[index] Variabili principali:");
  console.log("[index] GUILD_ID:", GUILD_ID);
  console.log("[index] CLIENT_ID:", CLIENT_ID);
  console.log("[index] PORT:", process.env.PORT || 3000);
  console.log(
    "[index] NEATQUEUE_WEBHOOK_PATH:",
    process.env.NEATQUEUE_WEBHOOK_PATH || "/neatqueue/webhook"
  );
  console.log(
    "[index] QUEUE_STATUS_CHANNEL_ID:",
    process.env.QUEUE_STATUS_CHANNEL_ID || "(non configurato)"
  );

  try {
    await ensureRankStore();
    console.log("[index] Rank store pronto");

    const guild = await client.guilds.fetch(GUILD_ID);
    const fullGuild = await guild.fetch();

    console.log("[index] Guild caricata:", {
      id: fullGuild.id,
      name: fullGuild.name,
      memberCount: fullGuild.memberCount,
    });

    const result = await syncOnlyVoiceUsers(client, fullGuild);
    console.log("[index] Sync iniziale completato:", result);

    setInterval(async () => {
      try {
        console.log("[index] Avvio sync orario...");
        const hourlyResult = await syncOnlyVoiceUsers(client, fullGuild);
        console.log("[index] Sync orario completato:", hourlyResult);
      } catch (error) {
        console.error("[index] Errore sync orario:", error);
      }
    }, SYNC_INTERVAL_MS);

    console.log("[index] Avvio monitor Twitch...");
    startTwitchMonitor(client);

    console.log("[index] Avvio webhook server NeatQueue...");
    startQueueChannelWebhookServer(client);
  } catch (error) {
    console.error("[index] Errore nel bootstrap del bot:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    console.log("[index] interactionCreate:", {
      type: interaction.type,
      isChatInputCommand: interaction.isChatInputCommand(),
      isStringSelectMenu: interaction.isStringSelectMenu(),
      userId: interaction.user?.id,
      commandName: interaction.commandName || null,
      customId: interaction.customId || null,
    });

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

      const linkEntry = await upsertRankLink(interaction.user.id, {
        profileId: String(profileId),
        playerName: player?.name || null,
        linkedAt: new Date().toISOString(),
        lastSoloRank: null,
        lastTeamRank: null,
      });

      const snapshot = await syncMemberRoles(
        client,
        interaction.guild,
        interaction.user.id,
        linkEntry
      );

      await interaction.update({
        content: [
          `Profilo collegato: **${player?.name || "Sconosciuto"}** (${profileId})`,
          await formatSnapshot(interaction.guild, snapshot),
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

      const linkEntry = await upsertRankLink(interaction.user.id, {
        profileId,
        playerName: player?.name || null,
        linkedAt: new Date().toISOString(),
        lastSoloRank: null,
        lastTeamRank: null,
      });

      const snapshot = await syncMemberRoles(
        client,
        interaction.guild,
        interaction.user.id,
        linkEntry
      );

      await interaction.editReply(
        [
          `Profilo collegato: **${player?.name || "Sconosciuto"}** (${profileId})`,
          await formatSnapshot(interaction.guild, snapshot),
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

        const linkEntry = await upsertRankLink(interaction.user.id, {
          profileId,
          playerName: playerProfile?.name || player?.name || null,
          linkedAt: new Date().toISOString(),
          lastSoloRank: null,
          lastTeamRank: null,
        });

        const snapshot = await syncMemberRoles(
          client,
          interaction.guild,
          interaction.user.id,
          linkEntry
        );

        await interaction.editReply(
          [
            `Profilo collegato automaticamente: **${playerProfile?.name || player?.name || "Sconosciuto"}** (${profileId})`,
            await formatSnapshot(interaction.guild, snapshot),
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
      const links = await loadRankLinks();
      const entry = links[interaction.user.id];

      if (!entry) {
        await interaction.reply({
          content: "Non hai nessun profilo collegato.",
          ephemeral: true,
        });
        return;
      }

      await deleteRankLink(interaction.user.id);

      await syncMemberRoles(client, interaction.guild, interaction.user.id, {
        profileId: null,
        lastSoloRank: null,
        lastTeamRank: null,
        clearOnly: true,
      });

      await interaction.reply({
        content: "Profilo scollegato e ruoli rank rimossi.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "syncme") {
      await interaction.deferReply({ ephemeral: true });

      const links = await loadRankLinks();
      const entry = links[interaction.user.id];

      if (!entry) {
        await interaction.editReply("Non hai ancora collegato un profilo. Usa `/link` o `/linkname`.");
        return;
      }

      const snapshot = await syncMemberRoles(client, interaction.guild, interaction.user.id, entry);

      await interaction.editReply(
        [`Ruoli aggiornati.`, await formatSnapshot(interaction.guild, snapshot)].join("\n")
      );
      return;
    }

    if (interaction.commandName === "syncvoice") {
      await interaction.deferReply({ ephemeral: true });

      const result = await syncOnlyVoiceUsers(client, interaction.guild);

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
    console.error("[index] Errore interaction completo:", error);
    console.error("[index] Codice errore:", error.code);
    console.error("[index] Messaggio errore:", error.message);
    console.error("[index] Stack:", error.stack);

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
  .then(async () => {
    console.log("[index] Login bot in corso...");
    await client.login(TOKEN);
    console.log("[index] Login completato");
  })
  .catch((error) => {
    console.error("[index] Errore avvio bot:", error);
  });
