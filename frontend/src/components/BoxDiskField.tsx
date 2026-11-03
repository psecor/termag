// The New box disk field, in each UI's standard field (shown while the
// orchestrator answers GET /api/instances/sizes with a `disk`, whatever
// box-default-size says; hooks/useBoxSizes.ts):
//
//   BoxDiskInput  the simple UI's box dialog: LaunchPad's NumberField, laid
//                 out like the dialog's Name field and Size select.
//   BoxDiskField  the full UI's New project form: a native number input in an
//                 npf-field, like its Box name field.
//
// Both show what the server says a box for the repository gets (its
// .termag/environment.json resources.diskGiB, else 120) until the person types,
// and send only what was typed (utils/boxDisk.ts). The range is the server's,
// which checks it again.
import React from 'react';
import { FieldError, Input, Label, NumberField, Text } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import { diskInputError, diskNote, diskShown, type BoxDiskOptions } from '../utils/boxDisk';

interface DiskProps {
  disk: BoxDiskOptions;
  /** What the person typed; null while they have not, and the server's answer shows. */
  typed: string | null;
  onType: (typed: string) => void;
  /** A warm-pool box is ready now, so another disk is slower: the field says so (utils/boxDisk.ts diskNote). */
  warmBoxReady?: boolean;
  disabled?: boolean;
}

export function BoxDiskInput({ disk, typed, onType, warmBoxReady = false, disabled, className }: DiskProps & { className?: string }) {
  const shown = diskShown(disk, typed);
  const error = diskInputError(disk, typed);
  const note = diskNote(disk, typed, warmBoxReady);
  return (
    <NumberField
      className={`${LP_THEME} box-disk-input${className ? ` ${className}` : ''}`}
      value={shown.trim() === '' ? NaN : Number(shown)}
      // Whole GB, no grouping: 300, never "300.5" or "1,000".
      formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
      minValue={disk.minGiB}
      maxValue={disk.maxGiB}
      step={1}
      onChange={value => onType(Number.isNaN(value) ? '' : String(value))}
      isDisabled={disabled}
      isInvalid={!!error}
    >
      <Label className="box-disk-input-label">Disk</Label>
      <Input className="box-disk-input-field" aria-label="Disk size in GB" />
      <Text slot="description" className="box-disk-input-hint">GB, {disk.minGiB}–{disk.maxGiB}</Text>
      {error && <FieldError className="box-disk-input-error">{error}</FieldError>}
      {/* Plain text: inside the field, LaunchPad's Text takes only its description and errorMessage slots. */}
      {note && <span className="box-disk-input-note">{note}</span>}
    </NumberField>
  );
}

export function BoxDiskField({ disk, typed, onType, warmBoxReady = false, disabled }: DiskProps) {
  const error = diskInputError(disk, typed);
  const note = diskNote(disk, typed, warmBoxReady);
  return (
    <div className="npf-field npf-inline">
      <label htmlFor="npf-box-disk">Disk (GB)</label>
      <input
        id="npf-box-disk"
        type="number"
        inputMode="numeric"
        min={disk.minGiB}
        max={disk.maxGiB}
        step={1}
        value={diskShown(disk, typed)}
        onChange={e => onType(e.target.value)}
        disabled={disabled}
        aria-invalid={!!error || undefined}
      />
      <span className="npf-note usage-dim">{disk.minGiB}–{disk.maxGiB}</span>
      {error && <span className="error-text">{error}</span>}
      {note && <span className="npf-note usage-dim">{note}</span>}
    </div>
  );
}
