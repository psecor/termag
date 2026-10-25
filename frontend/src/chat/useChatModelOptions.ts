// The models the simple UI's pickers offer: Claude's tiers, then the viewer's
// Fireworks models when Fireworks is on for them (GET /api/providers/models
// for the chat's agent).
import { useMemo } from 'react';
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { useBackendChoices } from '../providers/useBackendChoices';
import { chatModelOptions, type ChatModelOption } from './composer';

export function useChatModelOptions(): ChatModelOption[] {
  const choices = useBackendChoices(CHAT_PROVIDER_ID);
  return useMemo(() => chatModelOptions(choices.find(c => c.id === 'fireworks')?.models ?? []), [choices]);
}
