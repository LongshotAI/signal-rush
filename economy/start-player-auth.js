// start-player-auth.js
// Launches economy service with auth DISABLED for player endpoints.
process.env["ECONOMY_AUTH_ENFORCED"] = "false";
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
