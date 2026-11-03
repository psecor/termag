import { describe, expect, it } from 'vitest';
import * as cli from '../../../cli/src/secretPatterns';
import { SECRET_PATTERNS, findSecrets, findSecretsInText, redactSecrets } from './secretPatterns';
import * as askPublish from './askPublish';

// A PEM block built at run time: the gitleaks hook and ask publish refuse one as a literal.
const pemBody = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', 'Mzc1Rk3f4kZ8Qx2Tn0wq=='];
const pem = (kind = '', lines = pemBody) => [`-----BEGIN ${kind}${'PRIVATE'} KEY-----`, ...lines, `-----END ${kind}${'PRIVATE'} KEY-----`].join('\n');

describe('secret patterns', () => {
  it('are the same list in the CLI, which scans space memory on the box', () => {
    const shape = (list: ReadonlyArray<{ re: RegExp; what: string }>) => list.map(p => [p.re.source, p.re.flags, p.what]);
    expect(shape(cli.SECRET_PATTERNS)).toEqual(shape(SECRET_PATTERNS));
    const text = `aws AKIA${'A'.repeat(16)}\nslack xoxb-${'1'.repeat(12)}`;
    expect(cli.findSecretsInText(text)).toEqual(findSecretsInText(text));
    expect(cli.findSecrets(`+${text}`)).toEqual(findSecrets(`+${text}`));
    expect(cli.redactSecrets(text)).toEqual(redactSecrets(text));
  });

  it('find each kind on any line of a text, once', () => {
    const key = `AKIA${'B'.repeat(16)}`;
    expect(findSecretsInText(`a ${key}\nb ${key}`)).toEqual(['AWS access key id']);
    expect(findSecretsInText(`-----BEGIN RSA ${'PRIVATE'} KEY-----`)).toEqual(['private key']);
    expect(findSecretsInText('nothing here: AKIA123, ghp_short')).toEqual([]);
  });

  it('redact every match, each kind named once, and leave the rest', () => {
    const gh = `ghp_${'c'.repeat(36)}`;
    const r = redactSecrets(`push with ${gh}\nthen ${gh} again; key AKIA${'D'.repeat(16)}`);
    expect(r.text).toBe('push with [redacted: GitHub token]\nthen [redacted: GitHub token] again; key [redacted: AWS access key id]');
    expect(r.redacted).toEqual(['AWS access key id', 'GitHub token']); // in SECRET_PATTERNS order
    expect(redactSecrets('403 Forbidden')).toEqual({ text: '403 Forbidden', redacted: [] });
  });

  it('redact a whole PEM private key, body and END line included, in both copies', () => {
    for (const kind of ['', 'RSA ', 'OPENSSH ', 'EC ENCRYPTED ']) {
      const text = `key follows:\n${pem(kind)}\nafter the key`;
      const r = redactSecrets(text);
      expect(r).toEqual({ text: 'key follows:\n[redacted: private key]\nafter the key', redacted: ['private key'] });
      for (const line of pemBody) expect(r.text).not.toContain(line);
      expect(cli.redactSecrets(text)).toEqual(r);
    }
    // Two keys, each its own block; the text between them stays.
    expect(redactSecrets(`${pem()}\nbetween\n${pem('RSA ')}`).text).toBe('[redacted: private key]\nbetween\n[redacted: private key]');
    // On one line, as a bug report's title is.
    expect(redactSecrets(`leaked ${pem().replace(/\n/g, ' ')} in logs`).text).toBe('leaked [redacted: private key] in logs');
    // No END line (cut-off output): everything from BEGIN on goes.
    const cut = `oops\n${pem().split('\n').slice(0, 3).join('\n')}`;
    expect(redactSecrets(cut)).toEqual({ text: 'oops\n[redacted: private key]', redacted: ['private key'] });
    expect(cli.redactSecrets(cut)).toEqual(redactSecrets(cut));
  });

  it('stay exported from askPublish for its callers', () => {
    expect(askPublish.findSecrets).toBe(findSecrets);
    expect(askPublish.findSecretsInText).toBe(findSecretsInText);
  });
});
