/**
 * Slack Message Formatting Utilities
 */

export function formatResponse(response: string): string {
  if (!response) return '_No response from Claude._';
  return '```\n' + response + '\n```';
}

export function formatError(error: Error | string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `❌ *Error*\n\`\`\`\n${message}\n\`\`\`\n\n_Try \`help\` for usage info or \`new session\` to start fresh._`;
}

export function formatWelcome(): string {
  return `👋 *Hi! I'm the termag bot*

I can help you with coding tasks by running Claude Code on the server.

*How to use:*
• Just send me a message describing what you need
• I'll maintain context within our conversation
• Use \`new session\` to start fresh

*Terminal Commands (\`/t\`):*
• \`/t <command>\` - Send command to active project's agent
• \`/t ctrl <command>\` - Send to control terminal
• \`/t work <name> <command>\` - Send to a work terminal
• \`/t switch <project>\` - Change active project
• \`/t projects\` - List all projects with status
• \`/t ls\` - List all tmux sessions
• \`/t\` - Show current agent terminal output

*Session Commands:*
• \`help\` - Show this message
• \`status\` - Check your session info
• \`new session\` - Clear context and start over
• \`attach to <path>\` - Use a specific directory
• \`follow this channel\` / \`unfollow\` - Auto-respond in channel

_What would you like help with?_`;
}

export function truncateMessage(text: string, maxLength: number = 3900): string {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength - 100);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxLength / 2 ? lastNewline : truncated.length;
  return truncated.substring(0, cutPoint) + '\n\n_[Response truncated due to length]_';
}

export function splitMessage(text: string, maxLength: number = 3900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
