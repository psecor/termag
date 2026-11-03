// The simple UI's Resize box dialog, from a session's ⋯ menu (SessionHeader):
// LaunchPad's Modal, and the size in LaunchPad's Select as the New box dialog
// draws it (components/BoxSizePicker.tsx BoxSizeSelect), each size read
// "Medium · 4 vCPU, 16 GB RAM" with the current one marked. Then the
// one downtime warning, which is also the confirmation (Resize goes ahead
// whatever is running on the box), and the resize's progress. The full UI's is
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
import { sizeOptionLabel, sizeOptionParts, type BoxSize } from '../../utils/boxSize';
import { losesHibernation, resizeOptionLabel, resizeOutcome, resizeSteps, resizeWarning } from '../../utils/boxResize';

export function BoxResizeLaunchPad({ box, onClose, onChanged }: { box: Pick<Instance, 'id' | 'name'>; onClose: () => void; onChanged?: () => void }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const state = useBoxResize({ load: () => instancesApi.resizeInfo(box.id), send: (size, force) => instancesApi.resize(box.id, size, force) }, onChanged);
  const { info, loadError, picked, setPicked, submitting, error, resize, fromStatus } = state;
  const current = info?.box.size ?? null;
  const currentChoice = info?.sizes.find(s => s.size === current);
  const refusal = info?.refusal ?? null;
  const showProgress = fromStatus !== null && !!resize;
  const outcome = resize && info ? resizeOutcome(resize, info.sizes) : null;

  return (
    <ModalOverlay isOpen isDismissable={!submitting} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-resize-modal">
        <Dialog className="chat-resize-dialog" aria-label={`Resize ${box.name}`}>
          <Heading slot="title" level={2} size="medium">Resize {box.name}</Heading>
          {!info && <p>{loadError ?? 'Loading…'}</p>}
          {info && !showProgress && (
            <>
              <p className="chat-resize-now">
                Now: {currentChoice ? sizeOptionLabel(currentChoice) : info.box.instanceType ?? 'not recorded'}
              </p>
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
              <p className="chat-resize-warning" role={refusal ? 'status' : 'note'}>
                {refusal ? refusal.error : resizeWarning(info.box.status, !!picked && losesHibernation(info, picked))}
              </p>
              {error && <p className="chat-new-error" role="alert">{error}</p>}
            </>
          )}
          {info && showProgress && resize && (
            <div className="chat-resize-progress" role="status" aria-live="polite">
              <ol className="chat-resize-steps">
                {resizeSteps(resize, fromStatus ?? info.box.status).map(s => (
                  <li key={s.phase} data-state={s.state}>
                    {s.state === 'current'
                      ? <ProgressBar variant="spinner" size="small" isIndeterminate aria-label={s.label} />
                      : <Icon name={s.state === 'done' ? 'check' : 'circle-outline'} size="medium" aria-hidden="true" />}
                    <span>{s.label}</span>
                  </li>
                ))}
              </ol>
              {resize.running && <p className="chat-resize-note">You can close this; the resize carries on.</p>}
              {outcome && <p className={resize.phase === 'failed' ? 'chat-new-error' : 'chat-resize-note'}>{outcome}</p>}
            </div>
          )}
          <ButtonGroup className="chat-resize-buttons">
            {showProgress || !info ? (
              <Button variant="primary" onPress={onClose}>Close</Button>
            ) : (
              <>
                <Button variant="minimal" onPress={onClose} isDisabled={submitting}>Cancel</Button>
                <Button variant="primary" onPress={() => void state.submit()} isDisabled={submitting || !!refusal || !picked || picked === current}>
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
