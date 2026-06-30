// start-player-auth.js
// Launches the public economy service.
// Player-facing routes use Telegram session tokens; internal routes stay
// protected by ECONOMY_API_KEY unless explicitly disabled for local tests.
require('dotenv').config();
const { createServer } = require("./service.js");
const path = require("path");
const os = require("os");

const port = parseInt(process.env.ECONOMY_PORT) || 8720;
const host = process.env.ECONOMY_HOST || "0.0.0.0";
const dbPath = process.env.ECONOMY_DB || path.join(os.homedir(), ".signal-rush", "economy.db");

const server = createServer({ port, host, dbPath });
server.start().then(() => {
  console.log("[economy] Service running on " + host + ":" + port);
  console.log("[economy] Database: " + dbPath);
}).catch(err => {
  console.error("[economy] Failed to start:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => server.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => server.stop().then(() => process.exit(0)));
