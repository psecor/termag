import type { Router } from 'express';
import type { CallerProofConfig } from '../services/callerIdentity';
import { decideFireworksRequest } from '../services/fireworksAuthz';
import { fireworksModelsForBox } from '../services/fireworksFlag';
import { getFireworksGatewayConfig } from '../services/fireworksGateway';
import { boxForToken, gatewayCheckRouter } from './gatewayCheck';

/**
 * Envoy's ext_authz check for the gateway's Fireworks route: every model call
 * a box's pi or Claude Code makes, with the call's path appended. Envoy sends
 * no body: its Lua filter read the model and sends it as x-termag-fireworks-model.
 */
export function fireworksAuthzRouter(cfg: CallerProofConfig): Router {
  return gatewayCheckRouter(cfg, 'FIREWORKS-AUTHZ', 'The termag Fireworks gateway could not check this request', ({ req, path }) =>
    decideFireworksRequest(
      { path, authorization: req.headers.authorization, apiKey: req.header('x-api-key'), model: req.header('x-termag-fireworks-model') },
      {
        configured: getFireworksGatewayConfig() !== null,
        boxForToken,
        modelsFor: box => fireworksModelsForBox(box.userId, box.instanceId),
      },
    ));
}
