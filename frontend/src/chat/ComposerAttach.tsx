// The + in a composer's bar that picks files to attach (chat/useComposerAttachments.ts), shared
// by an open chat's composer and New session's. It picks any file, since a text file of any
// name goes too, and the composer says what it can't send. LaunchPad's FileTrigger
// owns the file input; its Pressable makes termag's own icon button the press
// target, so the button keeps the bar's look (.chat-icon-btn) beside the
// dictation and send buttons.
import { FileTrigger, Pressable } from '@launchpad-ui/components';
import { PlusIcon } from './ComposerIcons';

export function ComposerAttach({ onFiles, disabled, reserved, className = 'chat-icon-btn chat-attach' }: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** Holds the button's space, unseen and out of the tab order, while the composer may yet offer images. */
  reserved?: boolean;
  className?: string;
}) {
  if (reserved) return <span className={className} data-reserved="true" aria-hidden="true" />;
  return (
    <FileTrigger allowsMultiple onSelect={list => onFiles(Array.from(list ?? []))}>
      <Pressable isDisabled={disabled}>
        <button type="button" className={className} aria-label="Attach files" title="Attach files (or drop or paste them)" disabled={disabled}>
          <PlusIcon />
        </button>
      </Pressable>
    </FileTrigger>
  );
}
