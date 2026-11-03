// Effort in the composers' model menu:
// LaunchPad's Slider over Claude Code's five levels, Low to Max, and a Default
// chip beside it, since Default (no --effort) is not a point on that scale.
// While Default, the slider rests mid-track, hollow and unfilled; moving it or
// tapping the track picks a level. termag's first LaunchPad component: its
// stylesheet is cut down to the Slider's rules at build time
// (src/launchpad/launchpadCss.ts), and its colours are termag's (.chat-effort
// in pages/chat/chat.css).
import React, { useId, useLayoutEffect, useRef } from 'react';
import '@launchpad-ui/tokens/index.css';
import { Slider, SliderFill, SliderThumb, SliderTrack } from '@launchpad-ui/components';
import { CHAT_EFFORTS, EFFORT_LEVELS, type ChatEffortId } from './composer';

const LAST = EFFORT_LEVELS.length - 1;
/** Where the hollow thumb waits while Default: the middle stop, which says nothing about the model's own effort. */
const RESTING = Math.floor(LAST / 2);

export function EffortSlider({ effort, onChange }: { effort: ChatEffortId; onChange: (id: ChatEffortId) => void }) {
  const isDefault = effort === 'default';
  const index = isDefault ? RESTING : Math.max(0, EFFORT_LEVELS.findIndex(l => l.id === effort));
  const shown = isDefault ? CHAT_EFFORTS[0] : EFFORT_LEVELS[index];
  const pick = (value: number | number[]) => {
    const level = EFFORT_LEVELS[Array.isArray(value) ? value[0] : value];
    if (level) onChange(level.id);
  };
  // React Aria words the value with Intl.NumberFormat ("2"); a screen reader should hear the level.
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { input.current?.setAttribute('aria-valuetext', shown.label); });
  const labelId = useId();

  return (
    <div
      className="chat-effort"
      data-default={isDefault ? '' : undefined}
      // From Default, Enter or Space on the thumb picks the stop it rests on, as a tap on it does.
      onKeyDown={e => {
        if (!isDefault || (e.key !== 'Enter' && e.key !== ' ') || e.target !== input.current) return;
        e.preventDefault();
        pick(RESTING);
      }}
    >
      <div className="chat-effort-head">
        <span className="chat-compose-option-heading" id={labelId}>Effort</span>
        <button type="button" className="chat-effort-default" aria-pressed={isDefault} onClick={() => onChange('default')}>
          Default
        </button>
      </div>
      <Slider
        className="chat-effort-slider"
        aria-labelledby={labelId}
        minValue={0}
        maxValue={LAST}
        step={1}
        value={index}
        onChange={pick}
        // A tap on the resting stop changes no value, so Default leaves on the tap's end too.
        onChangeEnd={value => { if (isDefault) pick(value); }}
      >
        <SliderTrack className="chat-effort-track">
          {EFFORT_LEVELS.map((level, i) => (
            <span
              key={level.id}
              className="chat-effort-tick"
              style={{ left: `${(i / LAST) * 100}%` }}
              data-reached={!isDefault && i <= index ? '' : undefined}
              aria-hidden="true"
            />
          ))}
          <SliderFill className="chat-effort-fill" />
          <SliderThumb className="chat-effort-thumb" inputRef={input} />
        </SliderTrack>
      </Slider>
      <div className="chat-effort-readout">
        <span className="chat-effort-name">{shown.label}</span>
        <span className="chat-effort-hint">{shown.hint}</span>
      </div>
    </div>
  );
}
