/**
 * Discord.js Client Setup
 *
 * Creates and starts the Discord bot with required intents.
 * Runs in the same process as the Express server.
 */

import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { registerDiscordEvents } from './events';

let discordClient: Client | null = null;

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
    ],
  });

  registerDiscordEvents(client);
  discordClient = client;
  return client;
}

/** Logs in and registers the slash command; false when Discord is disabled or the login failed. */
export async function startDiscordClient(client: Client): Promise<boolean> {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;

  if (!token) {
    console.log('[DISCORD] Missing DISCORD_TOKEN — Discord bot disabled');
    return false;
  }

  try {
    await client.login(token);
    console.log(`[DISCORD] Bot connected as ${client.user?.tag}`);

    // Register slash commands
    if (appId) {
      await registerSlashCommands(token, appId);
    } else {
      console.warn('[DISCORD] Missing DISCORD_APP_ID — slash commands not registered');
    }
    return true;
  } catch (error) {
    console.error('[DISCORD] Failed to start:', (error as Error).message);
    return false;
  }
}

/**
 * Leaves the gateway. Notifications need the logged-in client, so a draining
 * process skips its Discord ones (getDiscordClient() is null until the next
 * createDiscordClient()).
 */
export async function stopDiscordClient(client: Client): Promise<void> {
  if (discordClient === client) discordClient = null;
  await client.destroy();
}

export function getDiscordClient(): Client | null {
  return discordClient;
}

async function registerSlashCommands(token: string, appId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);

  const command = new SlashCommandBuilder()
    .setName('t')
    .setDescription('Control termag terminal sessions')
    .addStringOption(opt =>
      opt.setName('command')
        .setDescription('Command to run (e.g. switch <project>, ctrl, projects, ls)')
        .setRequired(false)
    );

  try {
    await rest.put(Routes.applicationCommands(appId), {
      body: [command.toJSON()],
    });
    console.log('[DISCORD] Slash commands registered');
  } catch (err) {
    console.error('[DISCORD] Failed to register commands:', (err as Error).message);
  }
}
