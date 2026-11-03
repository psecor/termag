// The New box size dropdown, in each UI's standard dropdown (shown only while
// box-default-size is on, hooks/useBoxSizes.ts):
//
//   BoxSizeSelect  the simple UI's box dialog: LaunchPad's Select, as
//                  generative UI's Select field draws it (chat/genui/
//                  registry.tsx), laid out like the dialog's Name field.
//   BoxSizeField   the full UI's New project form: a native select in an
//                  npf-field, like its Agent and Model fields.
//
// Both preselect utils/boxSize.ts preselectedSize (what the server says a
// box for the repo launches at) until the person picks, mark no default, and
// read "Medium · 4 vCPU, 16 GB RAM" from the server's size table: the name
// emphasised and the specs muted in LaunchPad's options; one tone in the
// native select, which can't style part of an option. A repo whose
// .termag/environment.json asks for requirements adds one entry above the presets,
// named by the type EC2 matched them to (r8g.xlarge), and preselected.
import React, { useEffect } from 'react';
import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../launchpad/theme';
import { boxDiskLabel } from '../utils/boxDisk';
import { ensureLaunchPadSprite } from '../launchpad/sprite';
import { boxSizeBadge, preselectedSize, REPO_DEFAULT, sizeOptionLabel, sizeOptionParts, type BoxSizeOptions, type SizePick } from '../utils/boxSize';

interface SizeProps {
  /** For the repository the box is made for (hooks/useBoxSizes.ts), which sets the preselection. */
  options: BoxSizeOptions;
  /** The person's pick; null while they have not picked, and the preselection shows. */
  picked: SizePick | null;
  onPick: (size: SizePick) => void;
  disabled?: boolean;
}

/** The entries in order: the repo's own type when its environment.json asks for one, then the presets. */
function entries(options: BoxSizeOptions): Array<{ id: SizePick; name: string; specs: string | null; label: string }> {
  const repo = options.defaultRequirements;
  return [
    ...(repo ? [{ id: REPO_DEFAULT as SizePick, name: repo.instanceType, specs: null, label: repo.instanceType }] : []),
    ...options.sizes.map(s => ({ id: s.size as SizePick, ...sizeOptionParts(s), label: sizeOptionLabel(s) })),
  ];
}

export function BoxSizeSelect({ options, picked, onPick, disabled, className }: SizeProps & { className?: string }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const value = picked ?? preselectedSize(options);
  return (
    <Select
      className={`${LP_THEME} box-size-select${className ? ` ${className}` : ''}`}
      selectedKey={value}
      onSelectionChange={key => { if (key != null) onPick(String(key) as SizePick); }}
      isDisabled={disabled}
    >
      <Label className="box-size-select-label">Size</Label>
      <Button className="box-size-select-button">
        <SelectValue />
        <Icon name="chevron-down" size="small" />
      </Button>
      <Popover className={`${LP_THEME} box-size-select-popover`} placement="bottom start">
        <ListBox items={entries(options)}>
          {e => (
            <ListBoxItem id={e.id} textValue={e.label}>
              {/* One inline run, so the item's flex gap doesn't space the parts apart. */}
              <span className="box-size-option"><span className="box-size-name">{e.name}</span>{e.specs && <span className="box-size-specs"> · {e.specs}</span>}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function BoxSizeField({ options, picked, onPick, disabled }: SizeProps) {
  const value = picked ?? preselectedSize(options);
  return (
    <div className="npf-field">
      <label htmlFor="npf-box-size">Box size</label>
      <select id="npf-box-size" value={value} disabled={disabled} onChange={e => onPick(e.target.value as SizePick)}>
        {entries(options).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
      </select>
    </div>
  );
}

/**
 * A box's size beside its name in the Boxes list (utils/boxSize.ts
 * boxSizeBadge), with the disk it was made with (utils/boxDisk.ts) in its
 * tooltip; nothing when neither was recorded. The disk has no badge of its
 * own: the list is narrow, and a second badge cut box names to a letter.
 */
export function BoxSizeBadge({ size, instanceType, diskGiB }: { size?: string | null; instanceType?: string | null; diskGiB?: number | null }) {
  const badge = boxSizeBadge(size, instanceType);
  const disk = boxDiskLabel(diskGiB);
  if (!badge) return disk && <span className="box-kind-badge box-size-badge" title={disk}>{diskGiB} GB</span>;
  return <span className="box-kind-badge box-size-badge" title={disk ? `${badge.title} · ${disk}` : badge.title}>{badge.label}</span>;
}
