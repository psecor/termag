// The admin page's end-link button
// (SR15): an admin ends one preview link, by its name or its id, when its
// owner can't or won't (the kill switch would end every link). The route is
// POST /api/admin/preview-links/end (routes/admin/previewLinkEnd.ts), which
// ends the link's audience with reason `admin`, closes its sessions, holds the
// name 30 days and writes the audit row. LaunchPad controls, with a confirm.
// Not behind a flag: /admin is mounted outside FeatureFlagsProvider (App.tsx),
// so a flag read there is always its fallback; the page is admins' only, and
// the server decides (a 404 for no such link).
import React, { useState } from 'react';
import { Button, ButtonGroup, Dialog, FieldError, Heading, Input, Label, Modal, ModalOverlay, Text, TextField } from '@launchpad-ui/components';
import { adminApi } from '../../services/adminApi';
import { LP_THEME } from '../../launchpad/theme';

/**
 * A link's id (a cuid: `c` and 24 lowercase letters and digits, as Prisma
 * mints them) or its name (3 to 40 lowercase letters, digits and hyphens);
 * null for neither. A 25-character name that looks like a cuid is read as an
 * id: unlikely, and a 404 says so.
 */
export function linkRef(text: string): { name: string } | { id: string } | null {
  const v = text.trim().toLowerCase();
  if (/^c[a-z0-9]{24}$/.test(v)) return { id: v };
  if (/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v)) return { name: v };
  return null;
}

function errorText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e as Error).message;
}

export function AdminPreviewLinkEnd() {
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = linkRef(text);

  const end = async () => {
    if (!ref) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await adminApi.endPreviewLink(ref);
      setResult(r.alreadyEnded ? `${r.link.name} had already ended (${r.link.endReason ?? 'ended'}).` : `Ended ${r.link.name}. Its viewers are out, and the name stays held 30 days.`);
      setText('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section className={`dash-section ${LP_THEME} admin-preview-end`}>
      <div className="dash-section-title">End a preview link</div>
      <Text elementType="p" className="usage-dim">For a link that has to stop now. It ends that one link for everyone and is in the audit log; the kill switch ends them all.</Text>
      <div className="admin-preview-end-row">
        <TextField value={text} onChange={setText} isInvalid={text.trim() !== '' && !ref} className="admin-preview-end-field">
          <Label>The link's name or id</Label>
          <Input className="admin-mono" placeholder="shop-feature-x" spellCheck={false} />
          <FieldError>A link's name (3 to 40 lowercase letters, digits and hyphens) or its id.</FieldError>
        </TextField>
        <Button variant="destructive" isDisabled={!ref || busy} onPress={() => setConfirming(true)}>End link…</Button>
      </div>
      {result && <Text elementType="p" role="status">{result}</Text>}
      {err && <Text elementType="p" role="alert" className="admin-warn">{err}</Text>}
      <ModalOverlay isOpen={confirming} isDismissable onOpenChange={o => { if (!o) setConfirming(false); }} className={LP_THEME}>
        <Modal>
          <Dialog aria-label="End this preview link">
            <Heading slot="title">End {ref && 'name' in ref ? ref.name : 'this link'}?</Heading>
            {/* A plain paragraph: inside a Dialog, Text only takes the subtitle slot. */}
            <p className="admin-preview-end-warn">Everyone viewing it loses it now, and its name stays held for 30 days. This can't be undone.</p>
            <ButtonGroup>
              <Button onPress={() => setConfirming(false)}>Cancel</Button>
              <Button variant="destructive" isDisabled={busy} onPress={() => void end()}>{busy ? 'Ending…' : 'End link'}</Button>
            </ButtonGroup>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  );
}
