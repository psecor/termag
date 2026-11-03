/**
 * termag-native port forwarding: loopback listeners on this machine, each
 * connection relayed over its own WebSocket through the orchestrator to a port
 * on a box. `termag forward` uses it: probe with
 * `probeForward`, then `startForward`, or fall back to `ssh -L` on a refusal
 * whose `fallback` is set.
 */
export { probeForward, FORWARD_CAPABILITY, type ProbeResult } from './probe.js';
export { startForward, LISTEN_HOSTS, type Forward, type ForwardOptions, type Listening, type Totals } from './forwarder.js';
export { parsePortSpec, parsePortSpecs, MIN_LOCAL_PORT, type ForwardPort } from './ports.js';
export { describeRefusal, sshFallback, CLOSE, type RefusalCode } from './refusals.js';
export { portHolder } from './holder.js';
export { SUBPROTOCOL, SUBPROTOCOL_V2 } from './dial.js';
