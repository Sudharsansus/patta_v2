'use strict';

/**
 * Shared keep-alive HTTPS agents for the government axios clients.
 * The headline "speed" win is largely already realized (Node 19+ keep-alives
 * globalAgent), so the real value here is resilience/politeness: BOUNDED sockets
 * (a burst doesn't look abusive to the govt firewall) and a hard socket timeout
 * that drops a stuck connection instead of hanging the request.
 *
 * Transport pooling is NOT session persistence — each request keeps its own
 * CookieJar — so this stays stateless-safe.
 */
const https = require('https');

// Default secure agent for the eservices.tn.gov.in endpoints.
const agent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, maxFreeSockets: 4, timeout: 8000,
});

// Insecure variant used ONLY for the allow-listed FMB sketch host (collabland-tn),
// whose cert chain the production integration deliberately does not verify.
const insecureAgent = new https.Agent({
  keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8, maxFreeSockets: 2, timeout: 15000,
  rejectUnauthorized: false,
});

module.exports = { agent, insecureAgent };
