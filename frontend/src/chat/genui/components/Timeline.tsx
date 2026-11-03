// Events in time order, down a rail of dots. Hand-rolled: LaunchPad has no
// timeline, and this is a static list (an <ol>), not a control.
import React from 'react';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './Timeline.css';

const props = z.object({
  events: z.array(z.object({
    id: z.string().min(1).max(100),
    time: z.string().min(1).max(60),
    title: z.string().min(1).max(200),
    detail: z.string().max(2000).optional(),
    tone: z.enum(['default', 'info', 'success', 'warning', 'danger']).optional(),
  })).min(1).max(50),
});

/** What a tone's dot colour says, for a screen reader. */
const TONE_WORD = { info: 'note', success: 'success', warning: 'warning', danger: 'problem' } as const;

function Timeline({ events }: z.infer<typeof props>) {
  // A repeated id would collide as a key; the second keeps its place under its index.
  const seen = new Set<string>();
  const keyed = events.map((e, i) => {
    const key = seen.has(e.id) ? `${e.id}#${i}` : e.id;
    seen.add(e.id);
    return { key, e };
  });
  return (
    <ol className="genui-timeline">
      {keyed.map(({ key, e }) => {
        const tone = e.tone ?? 'default';
        return (
          <li key={key} className="genui-timeline-event" data-tone={tone}>
            <span className="genui-timeline-dot" aria-hidden="true" />
            <div className="genui-timeline-body">
              <div className="genui-timeline-head">
                <span className="genui-timeline-title">
                  {e.title}
                  {tone !== 'default' && <span className="genui-sr"> ({TONE_WORD[tone]})</span>}
                </span>
                <span className="genui-timeline-time">{e.time}</span>
              </div>
              {e.detail && <p className="genui-timeline-detail">{e.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default defineGenUiComponent({
  name: 'Timeline',
  props,
  description: 'Events in time order down a line of dots, for what happened (a deploy\'s history, an incident, a PR\'s activity); use Steps for a plan or a run that is still under way. Each event has a unique id, a time as you would write it ("Oct 27, 4:09 PM"), a title, an optional detail line and a tone (info, success, warning, danger) that colours its dot. They are drawn in the order given: newest first unless the story reads better oldest first. At most 50.',
  Component: ({ props: p }) => <Timeline {...p} />,
});
