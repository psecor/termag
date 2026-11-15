// The notice banner: one notice across the top of
// the main pane, from the JSON flag notice-banner, which the flag client
// streams, so a publish reaches open tabs without a reload. It renders nothing
// when there is no notice, after its end time, or once this browser dismissed
// its id. The chat UI mounts it once in ChatApp; the caller's className places it.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Code, Link, Text } from '@launchpad-ui/components';
import { FLAGS, useFlag } from '../flags';
import { LP_THEME } from '../launchpad/theme';
import { ensureLaunchPadSprite } from '../launchpad/sprite';
import {
  alertStatus, NOTICE_DISMISSED_KEY, noticeEnded, noticeParts, parseNotice, readDismissed, writeDismissed,
  type Notice,
} from './notice';
import './notice.css';

// setTimeout's longest delay; a later end time is checked again then.
const MAX_DELAY = 2 ** 31 - 1;

/**
 * Re-renders at the notice's end time, so it hides itself in an open tab. A
 * timer is set only while the end is still ahead of the last render's clock:
 * once it has passed there is nothing to wait for.
 */
function useEnded(notice: Notice | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  const endsAt = notice?.endsAt;
  const ended = notice ? noticeEnded(notice, now) : false;
  useEffect(() => {
    if (endsAt === undefined || ended) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(endsAt - Date.now(), 0) + 50, MAX_DELAY));
    return () => clearTimeout(t);
  }, [endsAt, ended, now]);
  return ended;
}

/** The ids this browser dismissed, kept in step with its other tabs. */
function useDismissed(): [string[], (id: string) => void] {
  const [ids, setIds] = useState(readDismissed);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === NOTICE_DISMISSED_KEY) setIds(readDismissed()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const dismiss = useCallback((id: string) => setIds(writeDismissed(id)), []);
  return [ids, dismiss];
}

// A command in the message, copied with a click. Hand-rolled: LaunchPad's Code
// is display only and it has no inline copy control; this is a plain button
// around it, so it takes focus and Enter like any other.
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
  };
  return (
    <button type="button" className="notice-cmd" onClick={copy} title="Copy" aria-label={`Copy ${text}`} data-copied={copied || undefined}>
      <Code size="small">{text}</Code>
      {copied && <span className="notice-copied" role="status">Copied</span>}
    </button>
  );
}

function Message({ message }: { message: string }) {
  return (
    <>
      {noticeParts(message).map((p, i) =>
        p.kind === 'code' ? <Command key={i} text={p.text} />
          : p.kind === 'bold' ? <strong key={i}>{p.text}</strong>
            : <React.Fragment key={i}>{p.text}</React.Fragment>)}
    </>
  );
}

/**
 * Whether the text is cut short by the phone's three-line clamp (notice.css),
 * measured while it is clamped and again when its width changes.
 */
function useClamped(ref: React.RefObject<HTMLElement | null>, expanded: boolean, key: string): boolean {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, expanded, key]);
  return clamped;
}

function Banner({ notice, onDismiss, className }: { notice: Notice; onDismiss: () => void; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLElement>(null);
  const clamped = useClamped(textRef, expanded, `${notice.title ?? ''}\n${notice.message}\n${notice.link?.label ?? ''}`);
  useEffect(() => { void ensureLaunchPadSprite().catch(() => {}); }, []);
  return (
    <div className={`notice-slot ${LP_THEME}${className ? ` ${className}` : ''}`} data-tone={notice.tone} data-expanded={expanded || undefined}>
      <Alert
        className="notice-alert"
        status={alertStatus(notice.tone)}
        isDismissable={notice.dismissible}
        isOpen
        onDismiss={onDismiss}
        aria-label="Notice"
      >
        <Text ref={textRef} elementType="p" className="notice-text">
          {notice.title && <strong className="notice-title">{notice.title}</strong>}
          {notice.title && ' '}
          <Message message={notice.message} />
          {notice.link && (
            <>
              {' '}
              <Link className="notice-link" href={notice.link.url} target="_blank" rel="noopener noreferrer">
                {notice.link.label}
              </Link>
            </>
          )}
        </Text>
        {(clamped || expanded) && (
          <Button variant="minimal" size="small" className="notice-more" aria-expanded={expanded} onPress={() => setExpanded(e => !e)}>
            {expanded ? 'Less' : 'More'}
          </Button>
        )}
      </Alert>
    </div>
  );
}

/** The notice the flag serves, unless it has ended or this browser dismissed it. */
export function NoticeBanner({ className }: { className?: string }) {
  const value: unknown = useFlag(FLAGS.noticeBanner, null);
  // A streamed update is a new object even when nothing changed; compare by content.
  const raw = useMemo(() => JSON.stringify(value ?? null), [value]);
  const notice = useMemo(() => parseNotice(JSON.parse(raw)), [raw]);
  const ended = useEnded(notice);
  const [dismissed, dismiss] = useDismissed();
  if (!notice || ended || dismissed.includes(notice.id)) return null;
  return <Banner key={notice.id} notice={notice} className={className} onDismiss={() => dismiss(notice.id)} />;
}
