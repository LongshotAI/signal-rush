process.env.ECONOMY_PORT = process.env.ECONOMY_PORT || '8720';
process.env.ECONOMY_DB = process.env.ECONOMY_DB || ':memory:';
if (process.env.ECONOMY_AUTH_ENFORCED !== 'false' && !process.env.ECONOMY_API_KEY) {
  console.warn('[economy] WARNING: Auth is enabled (ECONOMY_AUTH_ENFORCED is not false) but ECONOMY_API_KEY is not set. Requests with valid API keys will be accepted, but the shared-secret bridge will not work.');
}
require('./service.js');
