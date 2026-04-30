const process = require("node:process");
const fs = require("node:fs");
const path = require("node:path");

// Su Node 20+/22 possiamo caricare `.env` senza dipendenze esterne.
const envFilePath = path.join(__dirname, ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

process.on("uncaughtException", (error) => {
  console.error("[bootstrap] uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[bootstrap] unhandledRejection:", reason);
});

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
const { createLogger } = require("./debug");
const {
  addTwitchSubscriptionByInput,
  formatTwitchSubscription,
  loadTwitchSubscriptions,
  removeTwitchSubscriptionByInput,
  startTwitchMonitor,
} = require("./twitch");
const {
  addYoutubeSubscriptionByInput,
  formatYoutubeSubscription,
  loadYoutubeSubscriptions,
  removeYoutubeSubscriptionByInput,
  startYoutubeMonitor,
} = require("./youtube");
const { ensureMonitorStore } = require("./monitorStore");
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
const logger = createLogger("index");

logger.info("Bootstrap avviato", {
  hasToken: Boolean(process.env.DISCORD_BOT_TOKEN),
  hasClientId: Boolean(process.env.DISCORD_CLIENT_ID),
  hasGuildId: Boolean(process.env.DISCORD_GUILD_ID),
  hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
  hasSupabaseKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

function isIgnorableInteractionError(error) {
  return error?.code === 10062 || error?.code === 40060;
}

async function safelyRespondToInteractionError(interaction, message) {
  if (!interaction?.isRepliable?.()) {
    return;
  }

  try {
    if (interaction.deferred) {
      await interaction.editReply(message);
      return;
    }

    if (interaction.replied) {
      await interaction.followUp({ content: message, flags: 64 });
      return;
    }

    await interaction.reply({ content: message, flags: 64 });
  } catch (responseError) {
    if (isIgnorableInteractionError(responseError)) {
      logger.warn("Risposta interaction ignorata", {
        code: responseError.code,
        responseMessage: responseError.message,
      });
      return;
    }

    throw responseError;
  }
}

async function registerCommands() {
  logger.info("Registrazione comandi slash...");

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

    new SlashCommandBuilder()
      .setName("youtube")
      .setDescription("Gestisce i canali YouTube monitorati dal bot")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Aggiunge un canale YouTube al monitor")
          .addStringOption((option) =>
            option
              .setName("canale")
              .setDescription("Link del canale, handle @nome oppure channel ID")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Rimuove un canale YouTube dal monitor")
          .addStringOption((option) =>
            option
              .setName("canale")
              .setDescription("Link, handle, channel ID o nome del canale")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("Mostra i canali YouTube attualmente monitorati")
      ),

    new SlashCommandBuilder()
      .setName("twitch")
      .setDescription("Gestisce i canali Twitch monitorati dal bot")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Aggiunge un canale Twitch al monitor")
          .addStringOption((option) =>
            option
              .setName("canale")
              .setDescription("Link Twitch oppure login del canale")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Rimuove un canale Twitch dal monitor")
          .addStringOption((option) =>
            option
              .setName("canale")
              .setDescription("Link Twitch, login o nome del canale")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("Mostra i canali Twitch attualmente monitorati")
      ),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  logger.info("Comandi slash registrati con successo");
}

function getDiscordDisplayName(memberOrUser) {
  return (
    memberOrUser?.displayName ||
    memberOrUser?.globalName ||
    memberOrUser?.username ||
    null
  );
}

client.once("ready", async () => {
  logger.info("Bot online", {
    tag: client.user.tag,
    guildId: GUILD_ID,
    clientId: CLIENT_ID,
    port: process.env.PORT || 3000,
    debugEnabled: logger.enabled(),
  });

  try {
    await ensureRankStore();
    await ensureMonitorStore();
    logger.info("Rank store pronto");

    const guild = await client.guilds.fetch(GUILD_ID);
    const fullGuild = await guild.fetch();

    logger.info("Guild caricata", {
      id: fullGuild.id,
      name: fullGuild.name,
      memberCount: fullGuild.memberCount,
    });

    try {
      const result = await syncOnlyVoiceUsers(client, fullGuild);
      logger.info("Sync iniziale completato", result);
    } catch (error) {
      console.error("[index] Errore sync iniziale utenti vocali:", error);
    }

    setInterval(async () => {
      try {
        logger.info("Avvio sync orario...");
        const hourlyResult = await syncOnlyVoiceUsers(client, fullGuild);
        logger.info("Sync orario completato", hourlyResult);
      } catch (error) {
        console.error("[index] Errore sync orario:", error);
      }
    }, SYNC_INTERVAL_MS);

    logger.info("Avvio monitor Twitch...");
    startTwitchMonitor(client);

    logger.info("Avvio monitor YouTube...");
    startYoutubeMonitor(client);
  } catch (error) {
    console.error("[index] Errore nel bootstrap del bot:", error);
  }
});

client.on("error", (error) => {
  logger.error("Errore client Discord", {
    message: error.message,
    stack: error.stack,
  });
});

client.on("interactionCreate", async (interaction) => {
  try {
    logger.debug("interactionCreate", {
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

    logger.info("Comando ricevuto", {
      commandName: interaction.commandName,
      userId: interaction.user?.id || null,
    });

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
      return;
    }

    if (interaction.commandName === "youtube") {
      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "add") {
        const input = interaction.options.getString("canale", true).trim();
        const { subscription, alreadyExists } = await addYoutubeSubscriptionByInput(input);

        await interaction.editReply(
          [
            alreadyExists
              ? "Canale YouTube gia monitorato. Ho aggiornato i dati salvati."
              : "Canale YouTube aggiunto al monitor.",
            formatYoutubeSubscription(subscription),
            "I video gia pubblicati non verranno notificati: da ora in poi il bot mandera solo i nuovi upload.",
          ].join("\n")
        );
        return;
      }

      if (subcommand === "remove") {
        const input = interaction.options.getString("canale", true).trim();
        const removed = await removeYoutubeSubscriptionByInput(input);

        if (!removed) {
          await interaction.editReply("Non ho trovato un canale YouTube monitorato che corrisponda a quel valore.");
          return;
        }

        await interaction.editReply(
          [
            "Canale YouTube rimosso dal monitor.",
            formatYoutubeSubscription(removed),
          ].join("\n")
        );
        return;
      }

      if (subcommand === "list") {
        const subscriptions = await loadYoutubeSubscriptions();

        if (!subscriptions.length) {
          await interaction.editReply("Nessun canale YouTube monitorato al momento.");
          return;
        }

        await interaction.editReply(
          [
            `Canali YouTube monitorati: **${subscriptions.length}**`,
            subscriptions.map(formatYoutubeSubscription).join("\n"),
          ].join("\n")
        );
        return;
      }
    }

    if (interaction.commandName === "twitch") {
      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "add") {
        const input = interaction.options.getString("canale", true).trim();
        const { subscription, alreadyExists } = await addTwitchSubscriptionByInput(input);

        await interaction.editReply(
          [
            alreadyExists
              ? "Canale Twitch gia monitorato. Ho aggiornato i dati salvati."
              : "Canale Twitch aggiunto al monitor.",
            formatTwitchSubscription(subscription),
          ].join("\n")
        );
        return;
      }

      if (subcommand === "remove") {
        const input = interaction.options.getString("canale", true).trim();
        const removed = await removeTwitchSubscriptionByInput(input);

        if (!removed) {
          await interaction.editReply("Non ho trovato un canale Twitch monitorato che corrisponda a quel valore.");
          return;
        }

        await interaction.editReply(
          [
            "Canale Twitch rimosso dal monitor.",
            formatTwitchSubscription(removed),
          ].join("\n")
        );
        return;
      }

      if (subcommand === "list") {
        const subscriptions = await loadTwitchSubscriptions();

        if (!subscriptions.length) {
          await interaction.editReply("Nessun canale Twitch monitorato al momento.");
          return;
        }

        await interaction.editReply(
          [
            `Canali Twitch monitorati: **${subscriptions.length}**`,
            subscriptions.map(formatTwitchSubscription).join("\n"),
          ].join("\n")
        );
        return;
      }
    }
  } catch (error) {
    console.error("[index] Errore interaction completo:", error);
    console.error("[index] Codice errore:", error.code);
    console.error("[index] Messaggio errore:", error.message);
    console.error("[index] Stack:", error.stack);

    const message = `Errore: ${error.message}`;

    if (isIgnorableInteractionError(error)) {
      logger.warn("Interaction gia gestita o scaduta", {
        code: error.code,
        commandName: interaction.commandName || null,
        userId: interaction.user?.id || null,
      });
      return;
    }

    await safelyRespondToInteractionError(interaction, message);
  }
});

registerCommands()
  .then(async () => {
    logger.info("Login bot in corso...");
    await client.login(TOKEN);
    logger.info("Login completato");
  })
  .catch((error) => {
    console.error("[index] Errore avvio bot:", error);
  });
