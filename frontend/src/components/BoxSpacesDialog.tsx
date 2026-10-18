import { useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { spacesApi, type SpaceView } from '../services/api';
import { errorMessage } from '../services/spaceTransfer';
import type { Instance } from '../types';
import { roleAtLeast } from '../utils/spaces';

interface Row { space: SpaceView; access: 'explicit' | { via: string } | null }

/**
 * The box menu's "Spaces…": which of the user's spaces this box reaches, and
 * a switch per space. A box acts with the role of whoever added it.
 */
export function BoxSpacesDialog({ box, onClose, onOpenSpaces }: {
  box: Instance;
  onClose: () => void;
  /** No spaces yet: send the user to the sidebar to create one. */
  onOpenSpaces: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { spaces } = await spacesApi.list();
      const out = await Promise.all(spaces.map(async space => {
        const { boxes } = await spacesApi.boxes(space.name);
        if (boxes.some(b => b.id === box.id)) return { space, access: 'explicit' as const };
        const parent = boxes.find(b => b.children.some(c => c.id === box.id));
        return { space, access: parent ? { via: parent.name } : null };
      }));
      setRows(out);
    } catch (err) {
      setError(errorMessage(err, 'Could not load spaces'));
      setRows([]);
    }
  }, [box.id]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(row: Row) {
    setBusy(row.space.id);
    setError('');
    try {
      if (row.access === 'explicit') await spacesApi.removeBox(row.space.name, box.id);
      else await spacesApi.addBox(row.space.name, box.id);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not change access'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog title={`Spaces on “${box.name}”`} className="np-dialog box-spaces-dialog" onClose={onClose}>
      <div className="usage-dim space-hint">
        A space you turn on here is reachable from this box with <code>termag space</code>, with your role in that space.
      </div>
      {error && <div className="error-text">{error}</div>}
      {rows === null && <div className="usage-dim">Loading…</div>}
      {rows?.length === 0 && !error && (
        <div className="space-row-note">
          You are in no spaces yet. <button type="button" className="btn-tiny" onClick={onOpenSpaces}>Create one</button>
        </div>
      )}
      <ul className="box-spaces-list">
        {rows?.map(row => {
          const canChange = row.access === 'explicit' || (roleAtLeast(row.space.role, 'editor') && !row.space.readOnly);
          return (
            <li key={row.space.id}>
              <label>
                <input
                  type="checkbox"
                  checked={row.access === 'explicit'}
                  disabled={!canChange || busy !== null}
                  onChange={() => void toggle(row)}
                />
                <span className="box-spaces-name">{row.space.name}</span>
                <span className="usage-dim">
                  {row.space.role}
                  {row.access && row.access !== 'explicit' ? ` · inherited through ${row.access.via}` : ''}
                  {!canChange ? ' · viewers cannot add boxes' : ''}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="npf-actions">
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
