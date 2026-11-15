// "People I name" in the publish form: type to find termag users, pick
// several, each a removable tag. Suggestions are this browser's recent people
// as soon as the field has focus, then GET /api/users/search for what's typed
// (usePeopleSuggestions, which PersonPicker uses too). A full email no one
// matches can still be added, by its "Add" option, Enter or leaving the field:
// whether it's a termag user is the server's to say on publish. LaunchPad's ComboBox
// and TagGroup; the sprite comes from PreviewLinksPanel.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ComboBox, Group, Input, Label, ListBox, ListBoxItem, Popover, Tag, TagGroup, TagList, Text } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import { usePeopleSuggestions } from '../hooks/usePeopleSuggestions';
import { typedEmails } from './rules';

export interface PickedPerson { email: string; displayName: string }

/** A row of the list: a suggested person, or the typed emails to add as they are. */
type Option = { id: string; person: PickedPerson } | { id: string; add: string[] };

const ADD_KEY = 'add:';

/** What the open list says with no one in it. */
export function emptyHint(text: string): string {
  return text.trim().length < 2 ? 'Type a name or email' : 'No one on termag matches: type their full email to add it';
}

/**
 * `onPendingChange` gets the full emails typed but not added yet (none picked already), so the form can publish to them
 * too: Publish is pressed with the address still in the field (Devin, #1758).
 */
export function TeammatePicker({ value, onChange, onPendingChange }: {
  value: PickedPerson[];
  onChange: (next: PickedPerson[]) => void;
  onPendingChange?: (emails: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const { people, refreshRecent } = usePeopleSuggestions(text);
  // Whether the key going down is Escape (the wrapper's capture, before React Aria's handler): its commit cancels. Only that
  // key's: cleared by the commit that reads it and as the key comes up, so a later paste and blur adds (Bugbot, #1758).
  const escaping = useRef(false);

  const has = useMemo(() => new Set(value.map(p => p.email.toLowerCase())), [value]);
  const typed = typedEmails(text);
  const pending = (typed ?? []).filter(e => !has.has(e)).join(',');
  useEffect(() => { onPendingChange?.(pending ? pending.split(',') : []); }, [pending, onPendingChange]);
  const options = useMemo((): Option[] => {
    const out: Option[] = people.filter(p => !has.has(p.email.toLowerCase())).map(p => ({ id: p.email, person: p }));
    const fresh = (typed ?? []).filter(e => !has.has(e) && !out.some(o => 'person' in o && o.person.email.toLowerCase() === e));
    // Someone found for exactly what's typed is offered by name instead.
    if (fresh.length) out.unshift({ id: ADD_KEY + fresh.join(','), add: fresh });
    return out;
  }, [people, has, typed?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (more: PickedPerson[]) => {
    const seen = new Set(has);
    const next = [...value];
    for (const p of more) {
      const key = p.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ email: key, displayName: p.displayName });
    }
    if (next.length !== value.length) onChange(next);
    setText('');
  };

  const picked = (key: React.Key | null) => {
    if (key == null) {
      // React Aria commits the text with no option picked (Enter with none highlighted, blur, Escape) and leaves a controlled
      // field's text to us: left as it is, the list opens again. Escape drops it; otherwise full emails are added as typed
      // (a name the list has for one is kept), and anything else is dropped.
      const cancelled = escaping.current;
      escaping.current = false;
      if (!cancelled && typed) add(typed.map(email => ({ email, displayName: people.find(p => p.email.toLowerCase() === email)?.displayName ?? '' })));
      else setText('');
      return;
    }
    const option = options.find(o => o.id === String(key));
    if (option) add('person' in option ? [option.person] : option.add.map(email => ({ email, displayName: '' })));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && text === '' && value.length) onChange(value.slice(0, -1));
  };

  return (
    // React Aria lets an Escape on an empty field through, which would close the Share dialog with the list still up: it closes only the list.
    <div className="preview-links-people" onKeyDownCapture={e => { escaping.current = e.key === 'Escape'; }} onKeyUpCapture={() => { escaping.current = false; }} onKeyDown={e => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); } }}>
      <Label id={labelId}>Their termag emails</Label>
      {/* Over the field, so the open list never covers a tag's remove button; outside the ComboBox, whose list contexts a TagList inside it would take. */}
      {value.length > 0 && (
        <TagGroup aria-label="People who can open it" onRemove={keys => onChange(value.filter(p => !keys.has(p.email)))} className="preview-links-people-tags">
          <TagList items={value}>
            {p => (
              <Tag id={p.email} textValue={p.displayName ? `${p.displayName} ${p.email}` : p.email}>
                {p.displayName && <span className="preview-links-person-name">{p.displayName}</span>}
                <span className="preview-links-person-email">{p.email}</span>
              </Tag>
            )}
          </TagList>
        </TagGroup>
      )}
      <ComboBox<Option>
        aria-labelledby={labelId}
        items={options}
        inputValue={text}
        onInputChange={setText}
        selectedKey={null}
        onSelectionChange={picked}
        menuTrigger="focus"
        // React Aria builds controlled items a render late, so a list that was empty wouldn't open as results come in: it's open while
        // the field is focused, and says what to do when it has no one to offer.
        allowsEmptyCollection
        onOpenChange={isOpen => { setOpen(isOpen); if (isOpen) refreshRecent(); }}
        className="preview-links-people-field"
      >
        {/* With the bare Input the list was never placed (Chromium: hidden at 0,0); in a Group, as genui's ComboBox has it, it opens under the field at its width. */}
        <Group className="preview-links-people-group">
          <Input placeholder={value.length ? 'Add someone else' : 'Search by name or email'} onKeyDown={onKeyDown} spellCheck={false} />
        </Group>
        <Popover className={`${LP_THEME} preview-links-people-popover`} placement="bottom start">
          <ListBox<Option> renderEmptyState={() => <Text className="preview-links-people-empty" size="small">{emptyHint(text)}</Text>}>
            {o => 'person' in o ? (
              <ListBoxItem id={o.id} textValue={o.person.displayName || o.person.email}>
                <Text slot="label">{o.person.displayName || o.person.email}</Text>
                {o.person.displayName && <Text slot="description" size="small">{o.person.email}</Text>}
              </ListBoxItem>
            ) : (
              <ListBoxItem id={o.id} textValue={`Add ${o.add.join(', ')}`}>
                <Text slot="label">Add {o.add.join(', ')}</Text>
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
    </div>
  );
}
