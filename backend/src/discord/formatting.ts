/**
 * Discord message formatting for terminal pane output.
 */

import { EmbedBuilder } from 'discord.js';

export function formatPaneForDiscord(
  paneContent: string,
  command: string | null,
  sessionName: string,
): { content: string; embeds: EmbedBuilder[] } {
  // Trim and truncate pane content for Discord's limits
  const trimmed = paneContent.replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const maxLen = 1900; // Discord code block limit ~2000 chars with overhead
  const content = trimmed.length > maxLen
    ? '...' + trimmed.slice(trimmed.length - maxLen)
    : trimmed;

  const embed = new EmbedBuilder()
    .setColor(0x58a6ff)
    .setFooter({ text: sessionName });

  if (command) {
    embed.setTitle(`\`${command}\``);
  }

  return {
    content: '```\n' + content + '\n```',
    embeds: [embed],
  };
}
