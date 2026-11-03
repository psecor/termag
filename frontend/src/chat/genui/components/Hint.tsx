// A small info button whose tooltip explains the thing beside it (a label, a
// Stat, a setting): LaunchPad's IconButton and Tooltip. A press toggles the
// tooltip too, so it opens on a touch screen, where hover never happens; it
// sends nothing, so it works on a locked surface. The text is also the
// button's description, so a screen reader has it without opening anything.
import React, { useId, useState } from 'react';
import { IconButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { z } from 'zod';
import { LAYER } from '../kit';
import { defineGenUiComponent } from './index';
import './Hint.css';

export const HINT_LABEL = 'More about this';

const props = z.object({
  text: z.string().min(1).max(300),
  label: z.string().min(1).max(100).optional(),
});

function HintView({ text, label }: z.infer<typeof props>) {
  const [open, setOpen] = useState(false);
  const descId = useId();
  return (
    <span className="genui-hint">
      <TooltipTrigger delay={300} isOpen={open} onOpenChange={setOpen} shouldCloseOnPress={false}>
        <IconButton icon="info-circle-outline" variant="minimal" size="small" aria-label={label ?? HINT_LABEL} aria-describedby={descId}
          onPress={() => setOpen(o => !o)} />
        <Tooltip className={LAYER}>{text}</Tooltip>
      </TooltipTrigger>
      <span id={descId} hidden>{text}</span>
    </span>
  );
}

export default defineGenUiComponent({
  name: 'Hint',
  props,
  description: 'A small info button that shows a short explanation (text, up to 300 characters) on hover, focus or press. Put it right after what it explains, in a horizontal Stack with a Heading, Text, Stat or input, for a term or a number that needs a sentence of context; put longer or always-needed explanation in Text. label is its screen-reader name (default "More about this"; say what it is about, e.g. "About working time").',
  Component: ({ props: p }) => <HintView {...p} />,
});
