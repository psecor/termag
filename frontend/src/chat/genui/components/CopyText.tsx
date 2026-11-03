// A value to copy (a command, a branch name, an id) with LaunchPad's
// IconButton and a Tooltip that says "Copy", then "Copied". The value is a
// plain <code> (or text) in a box: LaunchPad's Code tints its text in the
// syntax string colour, which is wrong for a command or an id. Copying sends
// nothing, so it works on a locked surface; a refused clipboard fails quietly.
import React, { useEffect, useId, useRef, useState } from 'react';
import { IconButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { z } from 'zod';
import { LAYER } from '../kit';
import { defineGenUiComponent } from './index';
import './CopyText.css';

/** How long the button says "Copied". */
export const COPIED_MS = 1500;

const props = z.object({
  label: z.string().min(1).max(200).optional(),
  value: z.string().min(1).max(2000),
  code: z.boolean().optional(),
});

function CopyTextView({ label, value, code = true }: z.infer<typeof props>) {
  const [copied, setCopied] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const labelId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTipOpen(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setCopied(false); setTipOpen(false); }, COPIED_MS);
    };
    try {
      navigator.clipboard?.writeText(value).then(done, () => {});
    } catch { /* no clipboard here: nothing to say */ }
  };
  return (
    <div className="genui-copytext" role="group" aria-labelledby={label ? labelId : undefined}>
      {label && <span className="genui-copytext-label" id={labelId}>{label}</span>}
      <div className="genui-copytext-row">
        {code ? <code className="genui-copytext-value">{value}</code> : <span className="genui-copytext-value">{value}</span>}
        <TooltipTrigger delay={300} isOpen={tipOpen} onOpenChange={setTipOpen} shouldCloseOnPress={false}>
          <IconButton icon={copied ? 'check' : 'copy-content'} variant="minimal" size="small" aria-label={label ? `Copy ${label}` : 'Copy'} onPress={copy} />
          <Tooltip className={LAYER}>{copied ? 'Copied' : 'Copy'}</Tooltip>
        </TooltipTrigger>
      </div>
      <span className="genui-sr" role="status">{copied ? 'Copied' : ''}</span>
    </div>
  );
}

export default defineGenUiComponent({
  name: 'CopyText',
  props,
  description: 'A value with a copy button, for something the person will paste: a command, a branch name, an id. value is copied exactly (up to 2000 characters); label says what it is ("Branch", "Run locally"); code (default true) shows it in monospace, false for plain words. Use a CodeBlock for several lines of code, KeyValue for facts that need no copying.',
  Component: ({ props: p }) => <CopyTextView {...p} />,
});
