const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // Default to "info"

const logger = {
  debug: (...args) => ["debug"].includes(LOG_LEVEL) && console.debug("🐛 [DEBUG]", ...args),
  info: (...args) => ["debug", "info"].includes(LOG_LEVEL) && console.info("ℹ️ [INFO]", ...args),
  warn: (...args) => ["debug", "info", "warn"].includes(LOG_LEVEL) && console.warn("⚠️ [WARN]", ...args),
  error: (...args) => console.error("❌ [ERROR]", ...args), // Always show errors
};