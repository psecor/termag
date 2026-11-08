// A URL or a host to copy, in monospace, with LaunchPad's IconButton and a
// Tooltip that says "Copy", then "Copied" (as chat/genui's CopyText does; that
// one is a generative-UI component, not exported as a plain one).
import React, { useEffect, useRef, useState } from 'react';
import { IconButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';

export function CopyUrl({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTipOpen(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setCopied(false); setTipOpen(false); }, 1500);
    };
    try { navigator.clipboard?.writeText(value).then(done, () => {}); } catch { /* no clipboard: the URL is on screen to select */ }
  };
  return (
    <span className="preview-links-copy">
      <code className="preview-links-url" title={value}>{value}</code>
      <TooltipTrigger delay={300} isOpen={tipOpen} onOpenChange={setTipOpen} shouldCloseOnPress={false}>
        <IconButton icon={copied ? 'check' : 'copy-content'} variant="minimal" size="medium" aria-label={`Copy ${label}`} onPress={copy} />
        <Tooltip className={LP_THEME}>{copied ? 'Copied' : 'Copy'}</Tooltip>
      </TooltipTrigger>
      <span className="preview-links-sr" role="status">{copied ? 'Copied' : ''}</span>
    </span>
  );
}
