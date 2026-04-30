const { ChannelType } = require("discord.js");
const { createLogger } = require("./debug");
const {
  ensureRankStore,
  loadRankLinks,
  updateRankSnapshot,
} = require("./rankStore");
const logger = createLogger("rank");

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

// const CIV_ROLE_MAP = {
//   abbasid_dynasty: process.env.ROLE_CIV_ABBASID_DYNASTY,
//   ayyubids: process.env.ROLE_CIV_AYYUBIDS,
//   byzantines: process.env.ROLE_CIV_BYZANTINES,
//   chinese: process.env.ROLE_CIV_CHINESE,
//   delhi_sultanate: process.env.ROLE_CIV_DELHI_SULTANATE,
//   english: process.env.ROLE_CIV_ENGLISH,
//   french: process.env.ROLE_CIV_FRENCH,
//   golden_horde: process.env.ROLE_CIV_GOLDEN_HORDE,
//   holy_roman_empire: process.env.ROLE_CIV_HOLY_ROMAN_EMPIRE,
//   house_of_lancaster: process.env.ROLE_CIV_HOUSE_OF_LANCASTER,
//   japanese: process.env.ROLE_CIV_JAPANESE,
//   jeanne_darc: process.env.ROLE_CIV_JEANNE_DARC,
//   knights_templar: process.env.ROLE_CIV_KNIGHTS_TEMPLAR,
//   macedonian_dynasty: process.env.ROLE_CIV_MACEDONIAN_DYNASTY,
//   malians: process.env.ROLE_CIV_MALIANS,
//   mongols: process.env.ROLE_CIV_MONGOLS,
//   order_of_the_dragon: process.env.ROLE_CIV_ORDER_OF_THE_DRAGON,
//   ottomans: process.env.ROLE_CIV_OTTOMANS,
//   rus: process.env.ROLE_CIV_RUS,
//   sengoku_daimyo: process.env.ROLE_CIV_SENGOKU_DAIMYO,
//   tughlaq_dynasty: process.env.ROLE_CIV_TUGHLAQ_DYNASTY,
//   zhu_xis_legacy: process.env.ROLE_CIV_ZHU_XIS_LEGACY,
// };

const RANK_IMAGE_MAP = {
  bronze: process.env.RANK_IMAGE_BRONZE || "",
  silver: process.env.RANK_IMAGE_SILVER || "",
  gold: process.env.RANK_IMAGE_GOLD || "",
  platinum: process.env.RANK_IMAGE_PLATINUM || "",
  diamond: process.env.RANK_IMAGE_DIAMOND || "",
  conqueror: process.env.RANK_IMAGE_CONQUEROR || "",
};

const RANK_EMOJI_NAME_MAP = {
  solo: {
    bronze: "solo_bron3",
    silver: "solo_silver3",
    gold: "solo_gold3",
    platinum: "solo_plat3",
    diamond: "solo_diam3",
    conqueror: "solo_conq3",
  },
  team: {
    bronze: "team_bron",
    silver: "team_silv3",
    gold: "team_gold3",
    platinum: "team_plat3",
    diamond: "team_diam3",
    conqueror: "team_conq3",
  },
};

const SOLO_ROLE_IDS = Object.values(SOLO_ROLE_MAP).filter(Boolean);
const TEAM_ROLE_IDS = Object.values(TEAM_ROLE_MAP).filter(Boolean);
// const CIV_ROLE_IDS = Object.values(CIV_ROLE_MAP).filter(Boolean);

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

// function normalizeCivilizationName(value) {
//   if (!value) return null;
//
//   const normalized = String(value)
//     .trim()
//     .toLowerCase()
//     .replace(/['’]/g, "")
//     .replace(/[^a-z0-9]+/g, "_")
//     .replace(/^_+|_+$/g, "");
//
//   const aliases = {
//     hre: "holy_roman_empire",
//     holy_roman_empire_civilization: "holy_roman_empire",
//     jeanne_d_arc: "jeanne_darc",
//     order_of_dragon: "order_of_the_dragon",
//     zhu_xis_legacy: "zhu_xis_legacy",
//     zhu_xi_s_legacy: "zhu_xis_legacy",
//     tughluq_dynasty: "tughlaq_dynasty",
//   };
//
//   return aliases[normalized] || normalized;
// }
//
// function extractMostPlayedCivilization(profile) {
//   const directCandidates = [
//     profile?.most_played_civilization,
//     profile?.most_played_civ,
//     profile?.favorite_civilization,
//     profile?.favorite_civ,
//     profile?.main_civilization,
//     profile?.main_civ,
//   ];
//
//   for (const candidate of directCandidates) {
//     const normalized = normalizeCivilizationName(candidate);
//     if (normalized) {
//       return normalized;
//     }
//   }
//
//   const listCandidates = [
//     profile?.most_played_civilizations,
//     profile?.civilizations,
//     profile?.favorite_civilizations,
//     profile?.stats?.civilizations,
//     profile?.statistics?.civilizations,
//   ];
//
//   for (const candidate of listCandidates) {
//     if (Array.isArray(candidate) && candidate.length > 0) {
//       const firstItem = candidate[0];
//       const normalized = normalizeCivilizationName(
//         firstItem?.civilization ||
//           firstItem?.civ ||
//           firstItem?.name ||
//           firstItem?.civilization_name
//       );
//
//       if (normalized) {
//         return normalized;
//       }
//     }
//   }
//
//   return null;
// }

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

async function fetchPlayerProfile(profileId) {
  const url = `https://aoe4world.com/api/v0/players/${encodeURIComponent(profileId)}`;
  logger.debug("Recupero profilo AoE4World", { profileId: String(profileId) });
  return fetchJson(url, "Errore recupero profilo AoE4World");
}

async function searchPlayers(query) {
  const url = `https://aoe4world.com/api/v0/players/search?query=${encodeURIComponent(query)}`;
  logger.debug("Ricerca giocatori AoE4World", { query });
  const data = await fetchJson(url, "Errore ricerca giocatori AoE4World");

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.players)) return data.players;
  if (Array.isArray(data?.items)) return data.items;

  return [];
}

async function fetchLeaderboardEntry(leaderboard, profileId) {
  const url = `https://aoe4world.com/api/v0/leaderboards/${leaderboard}?profile_id=${encodeURIComponent(profileId)}`;
  logger.debug("Recupero leaderboard", { leaderboard, profileId: String(profileId) });
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
  logger.debug("Creo rank snapshot", { profileId: String(profileId) });
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

function getRankValue(rank) {
  const rankOrder = {
    bronze: 1,
    silver: 2,
    gold: 3,
    platinum: 4,
    diamond: 5,
    conqueror: 6,
  };

  return rankOrder[rank] || 0;
}

function formatRankLabel(rank) {
  if (!rank) return "Non classificato";
  return rank.charAt(0).toUpperCase() + rank.slice(1);
}

async function formatSnapshot(guild, snapshot) {
  const soloEmoji = snapshot.solo.rank
    ? await getRankEmoji(guild, "solo", snapshot.solo.rank)
    : "🏅";
  const teamEmoji = snapshot.team.rank
    ? await getRankEmoji(guild, "team", snapshot.team.rank)
    : "🏅";

  return [
    `Solo: ${soloEmoji} **${snapshot.solo.rank || "non classificato"}**${
      snapshot.solo.rating ? ` (${snapshot.solo.rating})` : ""
    }`,
    `Team: ${teamEmoji} **${snapshot.team.rank || "non classificato"}**${
      snapshot.team.rating ? ` (${snapshot.team.rating})` : ""
    }`,
  ].join("\n");
}

function getRankImage(rank) {
  return RANK_IMAGE_MAP[rank] || "";
}

async function getRankEmoji(guild, type, rank) {
  const emojiName = RANK_EMOJI_NAME_MAP[type]?.[rank];
  if (!emojiName) {
    return "🏅";
  }

  let emoji = guild.emojis.cache.find((item) => item.name === emojiName);

  if (!emoji) {
    await guild.emojis.fetch().catch(() => null);
    emoji = guild.emojis.cache.find((item) => item.name === emojiName);
  }

  return emoji ? emoji.toString() : "🏅";
}

async function sendRankUpMessage(client, guild, userId, type, oldRank, newRank) {
  const channelId = process.env.DISCORD_RANK_CHANNEL_ID;
  if (!channelId) return;

  logger.info("Invio notifica rank up", {
    userId,
    type,
    oldRank,
    newRank,
    channelId,
  });

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const modeLabel = type === "solo" ? "solo" : "team";
  const rankLabel = formatRankLabel(newRank);
  const rankEmoji = await getRankEmoji(guild, type, newRank);
  const imageUrl = getRankImage(newRank);

  const content = `Congratulazione a ${member} per aver raggiunto il rank di ${rankEmoji} ${rankLabel} in ${modeLabel}!`;

  const messagePayload = {
    content,
    allowedMentions: {
      users: [member.id],
      roles: [],
    },
  };

  if (imageUrl) {
    messagePayload.embeds = [
      {
        image: {
          url: imageUrl,
        },
      },
    ];
  }

  await channel.send(messagePayload);
}

async function handleRankUpNotifications(client, guild, discordUserId, oldSolo, newSolo, oldTeam, newTeam) {
  const soloIncreased =
    getRankValue(newSolo) > getRankValue(oldSolo) &&
    oldSolo &&
    newSolo &&
    oldSolo !== newSolo;

  const teamIncreased =
    getRankValue(newTeam) > getRankValue(oldTeam) &&
    oldTeam &&
    newTeam &&
    oldTeam !== newTeam;

  if (soloIncreased) {
    await sendRankUpMessage(client, guild, discordUserId, "solo", oldSolo, newSolo);
  }

  if (teamIncreased) {
    await sendRankUpMessage(client, guild, discordUserId, "team", oldTeam, newTeam);
  }
}

async function removeRankFamily(member, roleIdsToRemove, roleIdToKeep = null) {
  const botMember = await member.guild.members.fetchMe();

  const toRemove = [];

  for (const roleId of roleIdsToRemove) {
    if (!roleId || roleId === roleIdToKeep || !member.roles.cache.has(roleId)) {
      continue;
    }

    const role = member.guild.roles.cache.get(roleId);
    if (!role) {
      console.log(`Ruolo da rimuovere non trovato: ${roleId}`);
      continue;
    }

    if (role.managed) {
      console.log(`Non posso rimuovere il ruolo ${role.name}: è gestito da integrazione.`);
      continue;
    }

    if (role.position >= botMember.roles.highest.position) {
      console.log(
        `Non posso rimuovere il ruolo ${role.name}: è sopra o uguale al mio ruolo più alto (${botMember.roles.highest.name}).`
      );
      continue;
    }

    toRemove.push(roleId);
  }

  if (toRemove.length > 0) {
    logger.debug("Rimuovo ruoli rank", {
      memberId: member.id,
      roleIds: toRemove,
      keepRoleId: roleIdToKeep,
    });
    await member.roles.remove(toRemove, "Aggiornamento automatico rank AoE4");
  }
}

async function ensureRankRole(member, roleId) {
  if (!roleId) return;

  const role = member.guild.roles.cache.get(roleId);
  if (!role) {
    throw new Error(`Ruolo non trovato: ${roleId}`);
  }

  const botMember = await member.guild.members.fetchMe();

  if (role.managed) {
    throw new Error(`Il ruolo "${role.name}" è gestito da un'integrazione e non posso assegnarlo.`);
  }

  if (role.position >= botMember.roles.highest.position) {
    throw new Error(
      `Non posso assegnare il ruolo "${role.name}" perché è sopra o uguale al mio ruolo più alto ("${botMember.roles.highest.name}").`
    );
  }

  if (!member.roles.cache.has(roleId)) {
    logger.debug("Assegno ruolo rank", {
      memberId: member.id,
      roleId,
    });
    await member.roles.add(roleId, "Aggiornamento automatico rank AoE4");
  }
}

async function clearRankRoles(guild, discordUserId) {
  const member = await guild.members.fetch(discordUserId);
  await removeRankFamily(member, SOLO_ROLE_IDS, null);
  await removeRankFamily(member, TEAM_ROLE_IDS, null);
}

// async function syncCivilizationRole(member, profile) {
//   const civilization = extractMostPlayedCivilization(profile);
//   const civRoleId = civilization ? CIV_ROLE_MAP[civilization] : null;
//
//   await removeRankFamily(member, CIV_ROLE_IDS, civRoleId);
//
//   if (civRoleId) {
//     await ensureRankRole(member, civRoleId);
//   }
//
//   return civilization;
// }

async function syncMemberRoles(client, guild, discordUserId, linkEntry) {
  logger.info("Sync ruoli utente", {
    discordUserId,
    profileId: linkEntry?.profileId || null,
    clearOnly: Boolean(linkEntry?.clearOnly),
  });

  if (linkEntry?.clearOnly) {
    await clearRankRoles(guild, discordUserId);
    return {
      solo: { rank: null, rating: null },
      team: { rank: null, rating: null },
    };
  }

  const member = await guild.members.fetch(discordUserId);
  const snapshot = await getRankSnapshot(linkEntry.profileId);

  const oldSolo = linkEntry.lastSoloRank || null;
  const oldTeam = linkEntry.lastTeamRank || null;

  const newSolo = snapshot.solo.rank || null;
  const newTeam = snapshot.team.rank || null;

  const soloRoleId = newSolo ? SOLO_ROLE_MAP[newSolo] : null;
  const teamRoleId = newTeam ? TEAM_ROLE_MAP[newTeam] : null;

  logger.debug("Snapshot ruoli calcolato", {
    discordUserId,
    oldSolo,
    newSolo,
    oldTeam,
    newTeam,
    soloRoleId,
    teamRoleId,
  });

  await removeRankFamily(member, SOLO_ROLE_IDS, soloRoleId);
  await removeRankFamily(member, TEAM_ROLE_IDS, teamRoleId);

  if (soloRoleId) {
    await ensureRankRole(member, soloRoleId);
  }

  if (teamRoleId) {
    await ensureRankRole(member, teamRoleId);
  }

  await handleRankUpNotifications(
    client,
    guild,
    discordUserId,
    oldSolo,
    newSolo,
    oldTeam,
    newTeam
  );

  await updateRankSnapshot(discordUserId, {
    lastSoloRank: newSolo,
    lastTeamRank: newTeam,
  });

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

async function syncOnlyVoiceUsers(client, guild) {
  await guild.channels.fetch();

  const links = await loadRankLinks();
  const voiceMemberIds = getVoiceMemberIds(guild);

  logger.info("Sync utenti vocali avviato", {
    guildId: guild.id,
    voiceUsers: voiceMemberIds.size,
  });

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
      await syncMemberRoles(client, guild, memberId, linkEntry);
      updated += 1;
    } catch (error) {
      errors += 1;
      console.error(`Errore sync utente ${memberId}:`, error.message);
    }
  }

  logger.info("Sync utenti vocali completato", {
    processed,
    updated,
    skipped,
    errors,
  });

  return { processed, updated, skipped, errors };
}

module.exports = {
  ensureRankStore,
  loadRankLinks,
  fetchPlayerProfile,
  searchPlayers,
  syncMemberRoles,
  syncOnlyVoiceUsers,
  formatSnapshot,
};
