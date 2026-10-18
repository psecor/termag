import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from 'discord.js';

const { projectCreate, resolveDiscordUser } = vi.hoisted(() => ({
  projectCreate: vi.fn(),
  resolveDiscordUser: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    project: { create: projectCreate, update: vi.fn() },
    workflow: { create: vi.fn() },
  },
}));
vi.mock('./userMapping', () => ({ resolveDiscordUser }));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: () => false,
  sendToAgent: vi.fn(),
}));
vi.mock('../services/workstreams', () => ({
  ensureMainWorkstream: async () => ({ id: 'ws', name: 'main' }),
}));

import { registerDiscordEvents } from './events';

type Handler = (interaction: unknown) => Promise<void>;

function slashCommand(): Handler {
  let handler: Handler | undefined;
  const client = { on: (event: string, fn: Handler) => { if (event === 'interactionCreate') handler = fn; } };
  registerDiscordEvents(client as unknown as Client);
  return handler!;
}

function createInteraction() {
  return {
    isChatInputCommand: () => true,
    commandName: 't',
    user: { id: 'discord-user' },
    options: { getString: () => 'create hostproj' },
    reply: vi.fn(),
  };
}

const baseUser = {
  id: 'u1', unixUsername: 'alice', googleEmail: 'alice@example.com',
  adminSource: null, defaultAgentProvider: 'claude', slackUserId: null,
};

describe('Discord /t create', () => {
  beforeEach(() => {
    projectCreate.mockReset().mockResolvedValue({ id: 'p1' });
    resolveDiscordUser.mockReset();
  });

  it('refuses a host project for a non-admin', async () => {
    resolveDiscordUser.mockResolvedValue({ ...baseUser, role: 'member' });
    const interaction = createInteraction();
    await slashCommand()(interaction);
    expect(projectCreate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('must run on a box'));
  });

  it('still creates a host project for an admin', async () => {
    resolveDiscordUser.mockResolvedValue({ ...baseUser, role: 'admin' });
    await slashCommand()(createInteraction());
    expect(projectCreate).toHaveBeenCalledWith({ data: { name: 'hostproj', userId: 'u1' } });
  });
});
