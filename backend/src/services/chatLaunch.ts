// What a simple-UI chat's turn starts on, from its workstream's stored choice
// (Workflow.backend and Workflow.model): the `--model`, and
// on another backend what chat-send and chat-resume-claim carry for it. The
// chat routes and an automation run's brief both send through here.
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { launchChoice } from './agentRuntime';
import { CHAT_BACKEND_CAPABILITY, type ChatBackend } from './chatRunner';
import { claudeLaunchModel, claudeModelArg, resolvedChatTier, type ChatChoice } from './claudeChatModel';
import { fireworksModelsForBox } from './fireworksFlag';
import { FIREWORKS_CAPABILITY } from './fireworksGateway';

export type ChatLaunch = ChatBackend & { model: string | null };

export type ChatLaunchResult =
  | { ok: true; launch: ChatLaunch }
  | { ok: false; status: number; body: { error: string; code: string } };

/**
 * The launch for a chat's choice on the owner's box. The default backend is a
 * tier's launch string (claudeLaunchModel), Sonnet when none is stored. Fireworks needs
 * a box whose runner and credentials script take it, and the fireworks-models
 * flag on for the owner and box: the gateway's check reads the same flags, so
 * a refusal here says why before a turn would fail there. A model no longer
 * offered starts on the flag's default.
 */
export async function chatLaunchFor(
  choice: ChatChoice,
  box: { ownerId: string; instanceId: string | null; capabilities: readonly string[] },
): Promise<ChatLaunchResult> {
  if (choice.backend !== 'fireworks') {
    const tier = resolvedChatTier(choice.model);
    return { ok: true, launch: { model: claudeModelArg(claudeLaunchModel(tier)) ?? tier } };
  }
  if (!box.instanceId) {
    return { ok: false, status: 409, body: { error: 'Fireworks models run only on a box', code: 'backend-unavailable' } };
  }
  if (!box.capabilities.includes(CHAT_BACKEND_CAPABILITY) || !box.capabilities.includes(FIREWORKS_CAPABILITY)) {
    return {
      ok: false, status: 409,
      body: { error: 'This box cannot run chats on Fireworks yet. Update it (termag-box-update), or switch the chat to a Claude model.', code: 'runner-outdated' },
    };
  }
  const fireworks = await fireworksModelsForBox(box.ownerId, box.instanceId).catch((err: Error) => {
    console.warn(`[CHAT] fireworks flags for instance ${box.instanceId} unreadable: ${err.message}`);
    return null;
  });
  if (!fireworks) {
    return {
      ok: false, status: 403,
      body: { error: "Fireworks models are not on for this chat's owner and box. Switch the chat to a Claude model.", code: 'backend-off' },
    };
  }
  const l = launchChoice(CHAT_PROVIDER_ID, 'fireworks', choice.model, fireworks);
  return { ok: true, launch: { backend: 'fireworks', model: l.model, fastModel: l.fastModel, ...(l.context ? { context: l.context } : {}) } };
}
