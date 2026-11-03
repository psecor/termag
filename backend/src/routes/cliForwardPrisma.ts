/**
 * ForwardBoxes (routes/cliForward.ts) over the database and the agent
 * registry: who may forward to which box, as
 * cliT3Prisma.ts decides it for the desktop bridge.
 */
import { prisma } from '../db';
import { instanceAgentTransport } from '../services/agentRegistry';
import { PARKED_STATUSES } from '../services/boxPowerPolicy';
import { PORT_FORWARD_CAPABILITY, portForwardEnabled } from '../services/portForwardFlag';
import type { ForwardAccess, ForwardBoxes } from './cliForward';

const NOT_FOUND: ForwardAccess = { ok: false, status: 404, error: 'No such box', code: 'not_found' };

interface ForwardBoxesDeps {
  /** Overridable for tests. */
  transport?: typeof instanceAgentTransport;
  flag?: typeof portForwardEnabled;
}

export function createPrismaForwardBoxes(deps: ForwardBoxesDeps = {}): ForwardBoxes {
  const transport = deps.transport ?? instanceAgentTransport;
  const flag = deps.flag ?? portForwardEnabled;
  const parked = (status: string) => (PARKED_STATUSES as readonly string[]).includes(status);

  return {
    async access(user, boxId) {
      // Owner only: a shared project grants its sessions, not the box's loopback.
      const box = await prisma.instance.findFirst({
        where: { id: boxId, userId: user.id },
        select: { id: true, name: true, kind: true, status: true },
      });
      if (!box || box.status === 'terminated') return NOT_FOUND;
      const owner = await prisma.user.findUnique({ where: { id: user.id } });
      if (!owner || !(await flag(owner, box))) return NOT_FOUND;
      // Never started for a forward: the CLI says so and the owner starts it.
      if (parked(box.status)) return { ok: false, status: 409, error: `The box is ${box.status}; start it first`, code: 'box_parked' };
      const agent = transport(box.id);
      if (box.status !== 'ready' || !agent || !agent.helloReceived) {
        return { ok: false, status: 409, error: "The box isn't ready or its agent isn't connected", code: 'box_not_ready' };
      }
      if (!agent.capabilities.includes(PORT_FORWARD_CAPABILITY)) {
        return { ok: false, status: 501, error: 'This box needs an update to forward ports', code: 'box_outdated' };
      }
      return { ok: true };
    },

    async parked(boxId) {
      const box = await prisma.instance.findUnique({ where: { id: boxId }, select: { status: true } });
      return box !== null && parked(box.status);
    },
  };
}
