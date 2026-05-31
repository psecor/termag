/**
 * Slack Channel Management
 *
 * Creates and manages Slack channels for termag projects.
 * Channels are named proj-<project-name>.
 */

import { getSlackApp } from './app';

const CHANNEL_PREFIX = 'proj-';

/**
 * Create a Slack channel for a project and return the channel ID.
 * If the channel already exists, joins it and returns its ID.
 * Returns null if Slack is not configured or the call fails.
 */
export async function createProjectChannel(
  projectName: string,
  creatorSlackUserId?: string,
): Promise<string | null> {
  const slackApp = getSlackApp();
  if (!slackApp) return null;

  const channelName = `${CHANNEL_PREFIX}${projectName}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  try {
    const result = await slackApp.client.conversations.create({
      name: channelName,
      is_private: false,
    });

    const channelId = result.channel?.id;
    if (!channelId) return null;

    // Set topic
    await slackApp.client.conversations.setTopic({
      channel: channelId,
      topic: `termag project: ${projectName}`,
    }).catch(() => {});

    // Invite the creator if we know their Slack user ID
    if (creatorSlackUserId) {
      await slackApp.client.conversations.invite({
        channel: channelId,
        users: creatorSlackUserId,
      }).catch(() => {}); // may already be a member
    }

    console.log(`[SLACK] Created channel #${channelName} (${channelId})`);
    return channelId;
  } catch (err: unknown) {
    const error = err as { data?: { error?: string } };

    // Channel already exists — find and join it
    if (error.data?.error === 'name_taken') {
      try {
        // Search for existing channel
        const list = await slackApp.client.conversations.list({
          types: 'public_channel',
          limit: 1000,
        });
        const existing = list.channels?.find((c: any) => c.name === channelName);
        if (existing?.id) {
          // Bot joins the channel
          await slackApp.client.conversations.join({ channel: existing.id }).catch(() => {});
          if (creatorSlackUserId) {
            await slackApp.client.conversations.invite({
              channel: existing.id,
              users: creatorSlackUserId,
            }).catch(() => {});
          }
          console.log(`[SLACK] Joined existing channel #${channelName} (${existing.id})`);
          return existing.id;
        }
      } catch (listErr) {
        console.error('[SLACK] Failed to find existing channel:', (listErr as Error).message);
      }
    }

    console.error('[SLACK] Channel creation failed:', (err as Error).message);
    return null;
  }
}
