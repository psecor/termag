import { Router, RequestHandler } from 'express';
import { setStatus, getStatus, notifyStatusChange } from '../services/status';
import { AgentStatus } from '../types/index';

export function statusRouter(): Router {
  const router = Router();

  const postStatus: RequestHandler = (req, res) => {
    const { session, status, message } = req.body as {
      session?: string;
      status?: AgentStatus['status'];
      message?: string;
    };

    if (!session || !status) {
      res.status(400).json({ error: 'session and status required' });
      return;
    }

    const validStatuses: AgentStatus['status'][] = ['working', 'waiting', 'idle', 'not_running'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'invalid status' });
      return;
    }

    const updated = setStatus(session, status, message);
    notifyStatusChange(session);

    res.json({ ok: true, status: updated });
  };

  const getStatusHandler: RequestHandler = (req, res) => {
    const status = getStatus(req.params.session);
    res.json(status);
  };

  router.post('/', postStatus);
  router.get('/:session', getStatusHandler);

  return router;
}
