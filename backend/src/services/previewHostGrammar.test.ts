import { describe, expect, it } from 'vitest';
import {
  escapeRegexLiteral,
  nginxServerNameLine,
  normalisePreviewDomain,
  PREVIEW_HOST_LABEL_RE,
  PREVIEW_HOST_LABEL_SOURCE,
  PREVIEW_HOST_SUFFIX_SOURCE,
  PREVIEW_NAME_SOURCE,
  previewDomainRefusal,
} from './previewHostGrammar';
import { HOST_SUFFIX_RE, newHostSuffix, parseHostLabel, PREVIEW_NAME_RE } from './previewLinkRules';

describe('the preview host grammar', () => {
  it('anchors the name grammar for the backend', () => {
    expect(PREVIEW_NAME_RE.source).toBe(`^${PREVIEW_NAME_SOURCE}$`);
  });

  it('is <name>--<suffix> or the bare name', () => {
    for (const ok of [
      'abc', 'my-app', 'a1b', 'x'.repeat(40), 'my-app--k3x7q2', 'abc--abcd', `${'x'.repeat(40)}--abcdef`,
      // A name from before the `--` rule, bare and on its own host.
      'abc--d', 'ab--cd', 'my--app', 'abc--d--abcd', 'my-app--abcdefg', 'my-app--abc',
    ]) {
      expect(PREVIEW_HOST_LABEL_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      'ab', '-ab', 'ab-', 'My-app', 'my_app', 'x'.repeat(41), 'a.b', '', 'my-app---k3x7q2', 'a--abcd',
      'my-app--', '--k3x7q2', `${'x'.repeat(41)}--abcdef`,
    ]) {
      expect(PREVIEW_HOST_LABEL_RE.test(bad), bad).toBe(false);
    }
  });

  it('accepts exactly the labels parseHostLabel parses', () => {
    // Every label over a small alphabet up to 7 characters, and random longer ones.
    const alphabet = ['a', '2', '-', '0', 'z'];
    const labels: string[] = [];
    const grow = (prefix: string) => {
      if (prefix) labels.push(prefix);
      if (prefix.length < 7) for (const c of alphabet) grow(prefix + c);
    };
    grow('');
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      const n = 30 + Math.floor(rnd() * 25);
      labels.push(Array.from({ length: n }, () => (rnd() < 0.15 ? '-' : 'ab27x0'[Math.floor(rnd() * 6)])).join(''));
      labels.push(`${'x'.repeat(Math.floor(rnd() * 42))}--${'abc234'.slice(0, Math.floor(rnd() * 8))}`);
    }
    for (const l of labels) expect(PREVIEW_HOST_LABEL_RE.test(l), l).toBe(parseHostLabel(l) !== null);
  });

  it('builds the suffix rule from the same source', () => {
    expect(HOST_SUFFIX_RE.source).toBe(`^${PREVIEW_HOST_SUFFIX_SOURCE}$`);
    expect(HOST_SUFFIX_RE.test(newHostSuffix())).toBe(true);
  });

  it('keeps the label source safe inside a double-quoted nginx string', () => {
    // nginx reads `"` and `;` as syntax, `$` as a variable, `\` as an escape;
    // the generated line adds its own anchors.
    expect(PREVIEW_HOST_LABEL_SOURCE).not.toMatch(/["$;\\\s'^]/);
    expect(() => new RegExp(PREVIEW_HOST_LABEL_SOURCE)).not.toThrow();
  });
});

describe('normalisePreviewDomain', () => {
  it('reads the domain as the backend does', () => {
    expect(normalisePreviewDomain('  Previews.Test. ')).toBe('previews.test');
    expect(normalisePreviewDomain('.previews.test')).toBe('previews.test');
    expect(normalisePreviewDomain('')).toBeNull();
    expect(normalisePreviewDomain('  ')).toBeNull();
    expect(normalisePreviewDomain('...')).toBeNull();
    expect(normalisePreviewDomain(undefined)).toBeNull();
  });
});

describe('previewDomainRefusal', () => {
  it('is unset for no domain', () => {
    expect(previewDomainRefusal(null)).toBe('unset');
    expect(previewDomainRefusal('')).toBe('unset');
  });

  it('accepts two or more DNS labels', () => {
    for (const d of ['previews.test', 'a.previews.test', 'my-previews.example.test', 'xn--bcher-kva.test', `${'a'.repeat(63)}.test`]) {
      expect(previewDomainRefusal(d)).toBeNull();
    }
  });

  it('refuses anything nginx could read as syntax, or that is not a domain', () => {
    for (const d of [
      'test', 'previews..test', '-previews.test', 'previews-.test', 'previews.test;', 'previews.test"', "previews.test'",
      'previews.test }', 'previews test', 'previews.test\nserver_name x', '*.previews.test', 'previews.test:443',
      'previews.test/x', 'previews_test.test', 'büchér.test', 'previews.test$', 'pre{1}views.test', 'previews.te(st)',
      'previews.test\\', `${'a'.repeat(64)}.test`, `${'a.'.repeat(127)}test`,
    ]) {
      expect(previewDomainRefusal(d), d).toBe('malformed');
    }
  });
});

describe('nginxServerNameLine', () => {
  it('quotes the generated regex and escapes every dot of the domain', () => {
    expect(nginxServerNameLine('previews.test')).toBe(`server_name "~^${PREVIEW_HOST_LABEL_SOURCE}\\.previews\\.test$";\n`);
    expect(nginxServerNameLine('my-previews.example.test')).toBe(`server_name "~^${PREVIEW_HOST_LABEL_SOURCE}\\.my-previews\\.example\\.test$";\n`);
  });

  it('matches what the backend accepts as <label>.<domain>, and nothing else', () => {
    const line = nginxServerNameLine('previews.test');
    const re = new RegExp(/"~(.*)";/.exec(line)![1]);
    expect(re.test('my-app.previews.test')).toBe(true);
    expect(re.test('my-app.previewsxtest')).toBe(false);
    expect(re.test('a.b.previews.test')).toBe(false);
    expect(re.test('my-app.previews.test.evil.test')).toBe(false);
    expect(re.test('previews.test')).toBe(false);
  });

  it('never builds a line for a domain it refuses', () => {
    expect(() => nginxServerNameLine('previews.test"; include /etc/passwd; #')).toThrow(/malformed/);
    expect(() => nginxServerNameLine('')).toThrow(/unset/);
  });
});

describe('escapeRegexLiteral', () => {
  it('backslashes PCRE metacharacters', () => {
    expect(escapeRegexLiteral('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe('a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
    expect(escapeRegexLiteral('my-previews')).toBe('my-previews');
  });
});
