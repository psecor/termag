import { Router, RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { listSshKeys, registerSshKey, removeSshKey } from '../services/sshKeyRegistration';

export function sshKeysRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    res.json(await listSshKeys(req.user!.id));
  };

  const create: RequestHandler = async (req, res) => {
    const result = await registerSshKey(req.user!.id, (req.body as { publicKey?: unknown })?.publicKey);
    if (result.kind === 'invalid') { res.status(400).json({ error: result.message }); return; }
    if (result.kind === 'exists') {
      res.status(409).json({ error: `Key ${result.key.fingerprint} is already registered` });
      return;
    }
    res.status(201).json({ ...result.key, boxes: result.boxes });
  };

  const remove: RequestHandler = async (req, res) => {
    const result = await removeSshKey(req.user!.id, req.params.id);
    if (result.kind === 'not_found') { res.status(404).json({ error: 'Key not found' }); return; }
    res.json({ ok: true, boxes: result.boxes });
  };

  router.get('/', requireAuth, asyncHandler(list));
  router.post('/', requireAuth, asyncHandler(create));
  router.delete('/:id', requireAuth, asyncHandler(remove));

  return router;
}
