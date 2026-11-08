'use strict';
/**
 * The MCP broker connectors a chat turn may reach.
 * A confined turn (dontAsk, auto) runs
 * `--strict-mcp-config` from a scratch config dir, so nothing in
 * ~/.claude.json or the checkout's .mcp.json loads; this gives it back only
 * termag's own broker entries, and only when the orchestrator asks for them
 * in the send (`brokerMcp`, chat-confined-mcp-v1):
 *
 *   { connectors: 'owner', broker, allow, deny }  the box owner's connectors,
 *     through `broker` (the orchestrator's MCP_BROKER_URL), with the tool
 *     rules `allow` (--allowedTools) and `deny` (--disallowedTools)
 *   { connectors: 'none', broker? }  none: a sharee's turn on the owner's box
 *
 * The entries are rebuilt, never copied. ~/.config/termag/mcp.json is
 * termag-credentials' record of what it wrote, but any process of the box
 * user can rewrite it, an auto turn's Bash included, and headersHelper is a
 * shell command that hands the box token to whatever URL the entry names.
 * So only a record entry's name and connector id are read: the name must be
 * a connector name, the url exactly `<broker>/c/<id>` for the broker this
 * send names, the type http. The url and headersHelper written out are this
 * runner's own (its checkout's termag-mcp-headers and agent config, the
 * paths termag-credentials writes too). Anything else is dropped. The worst
 * a tampered record can then do is name another connector id, and the
 * broker's ext_authz answers only for the box owner's own connectors.
 */
const fs = require('fs');
const path = require('path');

const CAPABILITY = 'chat-confined-mcp-v1';
const RECORD = '.config/termag/mcp.json';
const MAX_RECORD_BYTES = 256 * 1024;
// Claude Code's own config, which a bypassPermissions turn loads; it holds a long history, so it may be large.
const CLAUDE_JSON = '.claude.json';
const MAX_CLAUDE_JSON_BYTES = 64 * 1024 * 1024;
// deploy/termag-credentials mcp_apply refuses a delivery outside these, so a record entry outside them is not its.
const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const CONNECTOR_ID = /^[a-z0-9]{1,40}$/;
const BROKER = /^https:\/\/[A-Za-z0-9.:-]+$/;
// One tool, or a trailing-* prefix of a server's tools (Claude Code permission rules). Never a whole server.
const TOOL_RULE = /^mcp__([a-z][a-z0-9-]{0,40})__([A-Za-z0-9_-]{1,64})(\*?)$/;
const MAX_RULES = 200;
// Every built-in a dontAsk turn keeps when it has servers: ToolSearch loads a deferred MCP tool's schema and runs nothing.
const TOOL_SEARCH = 'ToolSearch';

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Allow rules: an invalid one is dropped and the list cut short, which only allows less. */
function allowRulesOf(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(r => typeof r === 'string' && TOOL_RULE.test(r)))].slice(0, MAX_RULES);
}

/**
 * Deny rules, or null: dropping one would let an allow prefix call the tool
 * it named, so a list with one the box can't keep, or too many, is refused.
 */
function denyRulesOf(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_RULES) return null;
  if (!list.every(r => typeof r === 'string' && TOOL_RULE.test(r))) return null;
  return [...new Set(list)];
}

/** The server a tool rule names. */
function ruleServer(rule) {
  return TOOL_RULE.exec(rule)[1];
}

/** The send's `brokerMcp`, or null for none (an older orchestrator, or a turn it gives nothing to decide). */
function brokerMcpOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const broker = typeof raw.broker === 'string' && BROKER.test(raw.broker) ? raw.broker : null;
  if (raw.connectors === 'none') return broker ? { connectors: 'none', broker } : { connectors: 'none' };
  if (raw.connectors !== 'owner' || !broker) return null;
  // A deny list the box can't keep whole loads no connector at all (denyRulesOf).
  const deny = denyRulesOf(raw.deny);
  if (!deny) return null;
  return { connectors: 'owner', broker, allow: allowRulesOf(raw.allow), deny };
}

/** The record's entries by connector name, as read: [{ name, type, url }]. A missing or unreadable record is none. */
function recordedConnectors(home, fsImpl = fs) {
  const file = path.join(home, RECORD);
  let record;
  try {
    if (fsImpl.statSync(file).size > MAX_RECORD_BYTES) return [];
    record = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch { return []; }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.keys(record)
    .filter(name => CONNECTOR_NAME.test(name))
    .map((name) => {
      const e = record[name];
      return { name, type: e && e.type, url: e && typeof e.url === 'string' ? e.url : null };
    });
}

/**
 * The names of the servers in ~/.claude.json (the ones every project gets)
 * on `broker`: termag's, whatever the record says. An unreadable or
 * oversized file is none.
 */
function claudeJsonBrokerNames(home, broker, fsImpl = fs) {
  if (typeof broker !== 'string' || !BROKER.test(broker)) return [];
  const file = path.join(home, CLAUDE_JSON);
  let config;
  try {
    if (fsImpl.statSync(file).size > MAX_CLAUDE_JSON_BYTES) return [];
    config = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch { return []; }
  const servers = config && typeof config === 'object' ? config.mcpServers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const prefix = `${broker}/c/`;
  return Object.keys(servers).filter((name) => {
    const e = servers[name];
    return CONNECTOR_NAME.test(name) && e && typeof e.url === 'string' && e.url.startsWith(prefix);
  });
}

/**
 * The --mcp-config servers for `broker`, rebuilt from the record: an http
 * entry per connector name whose url is exactly `<broker>/c/<id>`, with this
 * runner's headersHelper. {} without both absolute paths.
 */
function brokerServers(home, broker, { headersHelper, agentConfig } = {}, fsImpl = fs) {
  const servers = {};
  if (typeof broker !== 'string' || !BROKER.test(broker)) return servers;
  if (typeof headersHelper !== 'string' || !path.isAbsolute(headersHelper)) return servers;
  if (typeof agentConfig !== 'string' || !path.isAbsolute(agentConfig)) return servers;
  const prefix = `${broker}/c/`;
  for (const { name, type, url } of recordedConnectors(home, fsImpl)) {
    if (type !== 'http' || !url || !url.startsWith(prefix)) continue;
    const id = url.slice(prefix.length);
    if (!CONNECTOR_ID.test(id)) continue;
    servers[name] = { type: 'http', url: `${prefix}${id}`, headersHelper: `${shQuote(headersHelper)} ${shQuote(agentConfig)}` };
  }
  return servers;
}

/**
 * What one Claude turn gets of termag's connectors, for permissionArgs, or
 * null for what it got before chat-confined-mcp-v1:
 *   { servers, allow, deny }  a confined turn: the --mcp-config servers and
 *     tool rules. dontAsk keeps only the servers with an allow rule (the
 *     others' every call would be refused); auto keeps them all, and what no
 *     rule allows goes to its classifier. A rule for a server not kept is
 *     dropped.
 *   { servers: null, allow: [], deny }  a bypassPermissions turn of a
 *     sharee: one deny rule per connector name, the record's and every
 *     server ~/.claude.json has on the send's broker (the turn loads that
 *     file, where termag-credentials wrote them, and a record that is gone
 *     or rewritten must not leave one out). A name that isn't a connector
 *     name is one termag never wrote.
 */
function turnMcp(home, mode, brokerMcp, paths, { loadsCheckoutConfig }, fsImpl = fs) {
  if (!brokerMcp) return null;
  if (loadsCheckoutConfig) {
    if (brokerMcp.connectors !== 'none') return null;
    const names = new Set([...recordedConnectors(home, fsImpl).map(c => c.name), ...claudeJsonBrokerNames(home, brokerMcp.broker, fsImpl)]);
    const deny = [...names].map(n => `mcp__${n}`);
    return deny.length ? { servers: null, allow: [], deny } : null;
  }
  if (brokerMcp.connectors !== 'owner') return null;
  const all = brokerServers(home, brokerMcp.broker, paths, fsImpl);
  const allowed = brokerMcp.allow.filter(r => Object.prototype.hasOwnProperty.call(all, ruleServer(r)));
  const keep = mode === 'dontAsk' ? new Set(allowed.map(ruleServer)) : new Set(Object.keys(all));
  const servers = {};
  for (const name of Object.keys(all)) if (keep.has(name)) servers[name] = all[name];
  if (!Object.keys(servers).length) return null;
  const kept = r => keep.has(ruleServer(r));
  return { servers, allow: allowed.filter(kept), deny: brokerMcp.deny.filter(kept) };
}

module.exports = {
  CAPABILITY,
  TOOL_SEARCH,
  brokerMcpOf,
  brokerServers,
  claudeJsonBrokerNames,
  recordedConnectors,
  turnMcp,
};
