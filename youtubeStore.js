const fs = require("fs");
const path = require("path");
const { createLogger } = require("./debug");

const DATA_FILE = path.join(__dirname, "youtubeSubscriptions.json");
const logger = createLogger("youtubeStore");

function ensureYoutubeStore() {
  if (!fs.existsSync(DATA_FILE)) {
    logger.info("Creo youtubeSubscriptions.json locale", { path: DATA_FILE });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ subscriptions: [] }, null, 2), "utf8");
  }
}

function loadYoutubeStore() {
  ensureYoutubeStore();

  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!raw || !Array.isArray(raw.subscriptions)) {
    return { subscriptions: [] };
  }

  return raw;
}

function saveYoutubeStore(data) {
  ensureYoutubeStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function loadYoutubeSubscriptions() {
  return loadYoutubeStore().subscriptions;
}

function upsertYoutubeSubscription(subscription) {
  const store = loadYoutubeStore();
  const index = store.subscriptions.findIndex(
    (entry) => String(entry.channelId).toLowerCase() === String(subscription.channelId).toLowerCase()
  );

  if (index >= 0) {
    store.subscriptions[index] = {
      ...store.subscriptions[index],
      ...subscription,
    };
  } else {
    store.subscriptions.push(subscription);
  }

  saveYoutubeStore(store);

  return store.subscriptions.find(
    (entry) => String(entry.channelId).toLowerCase() === String(subscription.channelId).toLowerCase()
  );
}

function removeYoutubeSubscription(channelId) {
  const store = loadYoutubeStore();
  const index = store.subscriptions.findIndex(
    (entry) => String(entry.channelId).toLowerCase() === String(channelId).toLowerCase()
  );

  if (index < 0) {
    return null;
  }

  const [removed] = store.subscriptions.splice(index, 1);
  saveYoutubeStore(store);
  return removed;
}

module.exports = {
  ensureYoutubeStore,
  loadYoutubeSubscriptions,
  upsertYoutubeSubscription,
  removeYoutubeSubscription,
};
