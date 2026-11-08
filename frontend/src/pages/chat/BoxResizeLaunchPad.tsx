// The simple UI's Resize box dialog, from a session's ⋯ menu (SessionHeader):
// LaunchPad's Modal, and the size in LaunchPad's Select as the New box dialog
// draws it (components/BoxSizePicker.tsx BoxSizeSelect), each size read
// "Medium · 4 vCPU, 16 GB RAM" with the current one marked, and the disk in
// the New box dialog's LaunchPad NumberField (components/BoxDiskField.tsx
// BoxDiskInput), from the current disk (grow only) up to the server's cap.
// Size, disk or both change in one go: the disk first, with the box up, then
// the resize, which waits for it. Then the one warning, which is also the
// confirmation (Resize goes ahead whatever is running on the box) and
// mentions the stop only when the size changes, and the progress. The full UI's is
// components/BoxResizeDialog.tsx; the state is hooks/useBoxResize.
import React, { useEffect } from 'react';
import {
  Button, ButtonGroup, Dialog, Heading, Label, ListBox, ListBoxItem, Modal, ModalOverlay, Popover, ProgressBar, Select, SelectValue,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { Instance } from '../../types';
import { instancesApi } from '../../services/api';
import { useBoxResize } from '../../hooks/useBoxResize';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { sizeOptionParts, type BoxSize } from '../../utils/boxSize';
import { changeWarning, retryNote, growOutcome, growSteps, losesHibernation, resizeOptionLabel, resizeOutcome, resizeSteps } from '../../utils/boxResize';
import { BoxDiskInput } from '../../components/BoxDiskField';
import { nowLine } from '../../components/BoxResizeDialog';

/** One progress list, the resize's or the disk's: a spinner on the current step, a check on the done ones. */
function Steps({ steps }: { steps: Array<{ key: string; label: string; state: 'done' | 'current' | 'todo' }> }) {
  return (
    <ol className="chat-resize-steps">
      {steps.map(s => (
        <li key={s.key} data-state={s.state}>
          {s.state === 'current'
            ? <ProgressBar variant="spinner" size="small" isIndeterminate aria-label={s.label} />
            : <Icon name={s.state === 'done' ? 'check' : 'circle-outline'} size="medium" aria-hidden="true" />}
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function BoxResizeLaunchPad({ box, onClose, onChanged }: { box: Pick<Instance, 'id' | 'name'>; onClose: () => void; onChanged?: () => void }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const state = useBoxResize({
    load: () => instancesApi.resizeInfo(box.id),
    send: (size, force) => instancesApi.resize(box.id, size, force),
    grow: sizeGb => instancesApi.growDisk(box.id, sizeGb),
  }, onChanged);
  const {
    info, loadError, picked, setPicked, submitting, error, resize, fromStatus, showProgress, grow, growShown, withDisk,
    diskOptions, diskTyped, setDiskTyped, diskTarget, sizeChanges, canSubmit, retry,
  } = state;
  const current = info?.box.size ?? null;
  const refusal = info?.refusal ?? null;
  const diskRefusal = info?.disk?.refusal ?? null;
  const showResize = fromStatus !== null && !!resize;
  const outcome = showResize && info ? resizeOutcome(resize, info.sizes) : null;
  const grown = growShown && grow ? growOutcome(grow) : null;
  const warning = info ? changeWarning(info.box.status, { size: sizeChanges, disk: diskTarget !== null }, sizeChanges && !!picked && losesHibernation(info, picked)) : null;

  return (
    <ModalOverlay isOpen isDismissable={!submitting} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-resize-modal">
        <Dialog className="chat-resize-dialog" aria-label={`Resize ${box.name}`}>
          <Heading slot="title" level={2} size="medium">Resize {box.name}</Heading>
          {!info && <p>{loadError ?? 'Loading…'}</p>}
          {info && !showProgress && (
            <>
              <p className="chat-resize-now">{nowLine(state)}</p>
              <Select
                className={`${LP_THEME} box-size-select chat-resize-select`}
                selectedKey={picked}
                onSelectionChange={key => { if (key != null) setPicked(String(key) as BoxSize); }}
                isDisabled={submitting || !!refusal}
              >
                <Label className="box-size-select-label">New size</Label>
                <Button className="box-size-select-button">
                  <SelectValue />
                  <Icon name="chevron-down" size="small" />
                </Button>
                <Popover className={`${LP_THEME} box-size-select-popover`} placement="bottom start">
                  <ListBox items={info.sizes.map(s => ({ ...s, id: s.size }))}>
                    {s => {
                      const { name, specs } = sizeOptionParts(s);
                      return (
                        <ListBoxItem id={s.size} textValue={resizeOptionLabel(s, current)}>
                          <span className="box-size-option">
                            <span className="box-size-name">{name}</span><span className="box-size-specs"> · {specs}</span>
                            {s.size === current && <span className="box-size-specs"> (current)</span>}
                          </span>
                        </ListBoxItem>
                      );
                    }}
                  </ListBox>
                </Popover>
              </Select>
              {refusal && <p className="chat-resize-warning" role="status">{refusal.error}</p>}
              {diskOptions && (
                <BoxDiskInput
                  className="chat-resize-disk"
                  label="New disk"
                  disk={diskOptions}
                  typed={diskTyped}
                  onType={setDiskTyped}
                  disabled={submitting || !!diskRefusal}
                />
              )}
              {retry ? (
                <div className="chat-resize-retry">
                  <p className="chat-new-error">{retryNote(retry)}</p>
                  <Button variant="default" onPress={() => void state.retryGrow()} isDisabled={submitting}>Finish growing the disk</Button>
                </div>
              ) : diskRefusal && <p className="chat-resize-note" role="status">{diskRefusal}</p>}
              {warning && <p className="chat-resize-warning" role="note">{warning}</p>}
              {error && <p className="chat-new-error" role="alert">{error}</p>}
            </>
          )}
          {info && showProgress && (
            <div className="chat-resize-progress" role="status" aria-live="polite">
              {growShown && grow && (
                <Steps steps={growSteps(grow).map(g => ({ key: g.key, label: g.label, state: g.state }))} />
              )}
              {grown && <p className={grow?.state === 'failed' ? 'chat-new-error' : 'chat-resize-note'}>{grown}</p>}
              {/* A grow that failed here can be finished here: same size, file system step only (Devin on #1214). */}
              {growShown && !grow?.running && retry && (
                <Button variant="default" onPress={() => void state.retryGrow()} isDisabled={submitting}>Finish growing the disk</Button>
              )}
              {showResize && (
                <Steps steps={resizeSteps(resize, fromStatus ?? info.box.status, withDisk).map(r => ({ key: r.phase, label: r.label, state: r.state }))} />
              )}
              {showResize && resize.running && <p className="chat-resize-note">You can close this; the resize carries on.</p>}
              {!showResize && grow?.running && <p className="chat-resize-note">The box stays up. You can close this; the disk carries on growing.</p>}
              {outcome && <p className={resize?.phase === 'failed' ? 'chat-new-error' : 'chat-resize-note'}>{outcome}</p>}
              {error && <p className="chat-new-error" role="alert">{error}</p>}
            </div>
          )}
          <ButtonGroup className="chat-resize-buttons">
            {showProgress || !info ? (
              <Button variant="primary" onPress={onClose}>Close</Button>
            ) : (
              <>
                <Button variant="minimal" onPress={onClose} isDisabled={submitting}>Cancel</Button>
                <Button variant="primary" onPress={() => void state.submit()} isDisabled={!canSubmit}>
                  {submitting ? 'Resizing…' : 'Resize'}
                </Button>
              </>
            )}
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
