process.env.ECONOMY_PORT = process.env.ECONOMY_PORT || '8720';
process.env.ECONOMY_DB = process.env.ECONOMY_DB || ':memory:';
process.env.ECONOMY_AUTH_ENFORCED = 'false';
require('./service.js');
