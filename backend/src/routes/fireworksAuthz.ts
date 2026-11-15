import type { Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { decideFireworksRequest } from '../services/fireworksAuthz';
import { getFireworksGatewayConfig } from '../services/fireworksGateway';
import { ownerKeyState, readFireworksKey, revalidateFireworksKey } from '../services/fireworksKey';
import { boolVariation } from '../services/featureFlags';
import { boxForTokenAt, gatewayCheckRouter } from './gatewayCheck';

/**
 * Envoy's ext_authz check for the gateway's Fireworks route: every model call
 * a box's pi or Claude Code makes, with the call's path appended. Envoy sends
 * no body: its Lua filter read the model and sends it as x-termag-fireworks-model,
 * which the check only logs (Fireworks' own governance decides which models run).
 * An allow can carry the box owner's own Fireworks key as x-termag-fireworks-key,
 * which Envoy sends to Fireworks in place of the box token.
 */
export function fireworksAuthzRouter(cfg: CallerProofConfig): Router {
  return gatewayCheckRouter(cfg, 'FIREWORKS-AUTHZ', 'The termag Fireworks gateway could not check this request', ({ req, path }) =>
    decideFireworksRequest(
      { path, authorization: req.headers.authorization, apiKey: req.header('x-api-key'), model: req.header('x-termag-fireworks-model') },
      {
        configured: getFireworksGatewayConfig() !== null,
        boxForToken: boxForTokenAt('fireworksGateway'),
        ownerKey: async userId => ownerKeyState(await readFireworksKey(userId)),
        keyRequired: async box => box.ld ? boolVariation('fireworks-own-key-required-enabled', box.ld.user, false, box.ld.box) : false,
        onOwnerKeyUsed: userId => { void revalidateFireworksKey(userId); },
      },
    ));
}
