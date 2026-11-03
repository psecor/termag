import { chatModelFromWire, chatModelLabel, chatModelWire, type ChatModelId, type ChatModelOption } from '../chat/composer';

/**
 * What an automation's runs start on, as the model pickers hold it (the
 * simple UI's chat/composer.ts ids: a Claude tier, or `fireworks:<model>`),
 * and the PATCH body that changes it (backend routes/automations.ts,
 * services/automations/model.ts). Shared by the simple UI's automation page
 * and the full UI's, like utils/automationDraft.ts.
 */

/** The view's backend and model as a picker id: no model on Claude is Sonnet, as a run with none starts on it. */
export function automationModelId(a: { backend?: string | null; model?: string | null }): ChatModelId {
  return chatModelFromWire(a.model ?? (a.backend === 'fireworks' ? null : 'sonnet'), a.backend) ?? 'sonnet';
}

/**
 * The picker's options with the automation's own choice in them: a Fireworks
 * model the owner is no longer offered (or Fireworks' default, which has no
 * id) still shows as the current one, though picking anything moves off it.
 */
export function automationModelOptions(current: ChatModelId, options: ChatModelOption[]): ChatModelOption[] {
  if (options.some(o => o.id === current)) return options;
  const label = current.startsWith('fireworks:') && current.length === 'fireworks:'.length ? 'Fireworks default' : chatModelLabel(current, options);
  return [...options, { id: current, label, fireworks: current.startsWith('fireworks:') }];
}

/** The PATCH body for a pick: both keys, so a Claude tier moves an automation off Fireworks. */
export function automationModelBody(id: ChatModelId): { backend: 'fireworks' | null; model: string } {
  const wire = chatModelWire(id);
  return { backend: wire.backend ?? null, model: wire.model };
}
