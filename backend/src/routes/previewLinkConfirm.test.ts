import { describe, expect, it } from 'vitest';
import { confirmPageBody } from './previewLinkConfirm';
import type { ConfirmPageView } from '../services/previewLinkConfirmations';

const view = (over: Partial<ConfirmPageView>): ConfirmPageView => ({
  state: 'confirmed', kind: 'publish', projectName: 'webapp', boxName: 'alicebox', fromBoxName: 'alicebox', workstream: 'main', port: 5173,
  name: 'my-app', audience: 'owner', emails: [], ttlHours: null, expiresAt: new Date('2026-11-12T20:00:00Z'), failure: null, shareUrl: null, csrf: 'c',
  agentAsk: { note: null, expiresAt: new Date('2026-11-13T20:00:00Z'), waiting: false }, linkUrl: null, ...over,
} as ConfirmPageView);

describe('the confirmed page', () => {
  it('says who can open it from the audience published, never from the agent-ask framing (#1568)', () => {
    expect(confirmPageBody(view({}), '/x')).toContain("only you and the project's collaborators can open it");
    for (const audience of ['link', 'people']) {
      expect(confirmPageBody(view({ audience }), '/x')).not.toContain("only you and the project's collaborators");
    }
  });
});
