const DEBUG_ENABLED_VALUES = new Set(["1", "true", "yes", "on", "debug"]);

function isDebugEnabled() {
  const value = String(process.env.DEBUG_BOT || "").trim().toLowerCase();
  return DEBUG_ENABLED_VALUES.has(value);
}

function serialize(meta) {
  if (meta === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (error) {
    return ` ${String(meta)}`;
  }
}

function createLogger(scope) {
  function write(level, message, meta) {
    const prefix = `[${scope}]`;
    const line = `${prefix} ${message}${serialize(meta)}`;

    if (level === "debug") {
      if (isDebugEnabled()) {
        console.log(line);
      }
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    if (level === "error") {
      console.error(line);
      return;
    }

    console.log(line);
  }

  return {
    debug(message, meta) {
      write("debug", message, meta);
    },
    info(message, meta) {
      write("info", message, meta);
    },
    warn(message, meta) {
      write("warn", message, meta);
    },
    error(message, meta) {
      write("error", message, meta);
    },
    enabled() {
      return isDebugEnabled();
    },
  };
}

module.exports = {
  createLogger,
  isDebugEnabled,
};
