// Where a person's New sessions run when they don't pick a box
// (Where new sessions run): reuse one of their boxes, or a fresh
// box. Their own choice beats the org default (box-placement-policy), which the
// line under it names. Only with box-placement-enabled, which the server also
// holds the write to; an older backend that sends no org default shows nothing.
import React, { useState } from 'react';
import { Button, Label, Radio, RadioGroup, Text } from '@launchpad-ui/components';
import { useAuth } from '../../contexts/AuthContext';
import { FLAGS, useFlag } from '../../flags';
import { LP_THEME } from '../../launchpad/theme';
import type { BoxPlacementPolicy } from '../../types';
import { DocsLink } from './DocsLink';

/** The org default as the line under the choice says it. */
export function orgDefaultWords(org: BoxPlacementPolicy): string {
  return org === 'fresh-first' ? 'a fresh box' : 'to reuse one of your boxes';
}

export function BoxPlacementSection() {
  const on = useFlag(FLAGS.boxPlacement, false);
  const { user, updatePreferences } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const org = user?.boxPlacementOrg;
  if (!on || !org) return null;
  const value: BoxPlacementPolicy = user?.boxPlacement ?? org;

  // null: follow the org's default again, wherever it goes later.
  const save = async (next: BoxPlacementPolicy | null) => {
    setBusy(true); setError('');
    try { await updatePreferences({ boxPlacement: next }); } catch { setError('Could not save that.'); } finally { setBusy(false); }
  };

  return (
    <section className="dash-section" id="where-new-sessions-run" aria-labelledby="box-placement-h">
      <div className="dash-section-title" id="box-placement-h">
        Where new sessions run <DocsLink anchor="where-new-sessions-run" topic="Where new sessions run" />
      </div>
      <div className="dash-card">
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <RadioGroup
          className={`${LP_THEME} settings-placement`}
          value={value}
          isDisabled={busy}
          onChange={v => { if (v === 'reuse-first' || v === 'fresh-first') void save(v); }}
        >
          <Label>When you don't pick a box, a new session runs on</Label>
          <Radio value="reuse-first">Reuse one of my boxes</Radio>
          <Radio value="fresh-first">A fresh box</Radio>
          <Text slot="description">
            Your default unless you pick a box. Your org's default is {orgDefaultWords(org)}.
          </Text>
        </RadioGroup>
        {/* Once chosen, the choice holds even when the org's default changes; this goes back to following it. */}
        {user?.boxPlacement && (
          <div className="settings-placement-actions">
            <Button className={`${LP_THEME} settings-placement-follow`} variant="minimal" size="small" isDisabled={busy} onPress={() => { void save(null); }}>
              Follow my org's default
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
