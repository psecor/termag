import React from 'react';
import { SettingsDocsAnchor, settingsDocsHref } from './settingsDocs';

interface Props {
  anchor: SettingsDocsAnchor;
  /** What the link explains: the tooltip and accessible name are "Docs: <topic>". */
  topic: string;
}

export function DocsLink({ anchor, topic }: Props) {
  const href = settingsDocsHref(anchor);
  if (!href) return null;
  const label = `Docs: ${topic}`;
  return (
    <a
      className="settings-docs-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <path
          d="M6.1 6.2a1.95 1.95 0 0 1 3.8.55c0 1.3-1.9 1.6-1.9 2.75"
          fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"
        />
        <circle cx="8" cy="11.6" r="0.8" fill="currentColor" />
      </svg>
    </a>
  );
}
