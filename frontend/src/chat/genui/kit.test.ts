import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { propsSchema } from './catalog';
import { withoutBlanks } from './kit';

describe('withoutBlanks', () => {
  const radio = propsSchema('RadioGroup')!;
  const options = [{ value: 'a', label: 'Alpha' }];

  it('drops an optional prop left as "" or null that fails as given, so it parses as left out', () => {
    const props = withoutBlanks(radio, { label: 'Where', value: '', options });
    expect(props).toEqual({ label: 'Where', options });
    expect(radio.safeParse(props).success).toBe(true);
    expect(withoutBlanks(propsSchema('CheckboxGroup')!, { label: 'L', value: null, options })).toEqual({ label: 'L', options });
    expect(withoutBlanks(propsSchema('Tabs')!, { tabs: [{ id: 'a', label: 'A' }], value: '' })).not.toHaveProperty('value');
  });

  it('keeps a blank the schema takes as given, and every required or nested one', () => {
    // A TextField's "" is a value (an empty field); a Select's null already means nothing chosen.
    expect(withoutBlanks(propsSchema('TextField')!, { label: 'Name', value: '' })).toEqual({ label: 'Name', value: '' });
    expect(withoutBlanks(propsSchema('Select')!, { label: 'L', value: null, options })).toEqual({ label: 'L', value: null, options });
    const required = { label: '', options: [{ value: '', label: 'Alpha' }] };
    expect(withoutBlanks(radio, required)).toBe(required);
    expect(radio.safeParse(required).success).toBe(false);
  });

  it('leaves the props as they are when the schema is not an object', () => {
    const props = { value: '' };
    expect(withoutBlanks(z.string(), props)).toBe(props);
  });
});
