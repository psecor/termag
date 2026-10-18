import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type AddressInfo, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { TLSSocket } from 'tls';
import { pemCertificates, postgresTrustAnchor } from './pgTrustAnchor';

// A throwaway PKI shaped like Amazon's: the server sends leaf + intermediate, and
// the bundle starts with an unrelated root (as the global bundle starts with
// sa-east-1's) ahead of the one that anchors the chain.
let dir: string;
const pki = {} as Record<'decoyRoot' | 'root' | 'intermediate' | 'leaf' | 'leafKey', string>;

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function makeRoot(name: string): void {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-days', '2', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
}

function makeSigned(name: string, issuer: string, ext: string): void {
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  writeFileSync(join(dir, `${name}.ext`), ext);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial',
    '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
}

/** Speaks just enough Postgres: answers SSLRequest with `answer`, then TLS with the leaf + intermediate. */
function fakePostgres(answer: 'S' | 'N'): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer(sock => {
      sock.once('data', () => {
        sock.write(answer);
        if (answer === 'N') return void sock.end();
        const tls = new TLSSocket(sock, {
          isServer: true,
          key: pki.leafKey,
          cert: `${pki.leaf}\n${pki.intermediate}\n`,
        });
        tls.on('error', () => {});
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pg-trust-anchor-'));
  makeRoot('decoy-root');
  makeRoot('rds-root');
  makeSigned('rds-intermediate', 'rds-root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  makeSigned('localhost', 'rds-intermediate', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim();
  pki.decoyRoot = read('decoy-root.pem');
  pki.root = read('rds-root.pem');
  pki.intermediate = read('rds-intermediate.pem');
  pki.leaf = read('localhost.pem');
  pki.leafKey = read('localhost.key');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pemCertificates', () => {
  it('splits a bundle in order', () => {
    expect(pemCertificates(`${pki.decoyRoot}\n${pki.root}\n`)).toEqual([pki.decoyRoot, pki.root]);
    expect(pemCertificates('')).toEqual([]);
  });
});

describe('postgresTrustAnchor', () => {
  it('returns the root that anchors the server, not the bundle\'s first certificate', async () => {
    const { server, port } = await fakePostgres('S');
    try {
      const bundle = `${pki.decoyRoot}\n${pki.root}\n`;
      const anchor = await postgresTrustAnchor({ host: 'localhost', port, ca: bundle });
      expect(pemCertificates(anchor)).toEqual([pki.root]);
      expect(pemCertificates(bundle)[0]).not.toBe(pki.root);
    } finally {
      server.close();
    }
  });

  it('refuses a server the bundle does not trust', async () => {
    const { server, port } = await fakePostgres('S');
    try {
      await expect(postgresTrustAnchor({ host: 'localhost', port, ca: pki.decoyRoot })).rejects.toThrow(/issuer|certificate/i);
    } finally {
      server.close();
    }
  });

  it('refuses a certificate for another hostname', async () => {
    const { server, port } = await fakePostgres('S');
    try {
      await expect(postgresTrustAnchor({ host: '127.0.0.1', port, ca: pki.root })).rejects.toThrow(/altnames|hostname|IP/i);
    } finally {
      server.close();
    }
  });

  it('refuses a server that declines TLS', async () => {
    const { server, port } = await fakePostgres('N');
    try {
      await expect(postgresTrustAnchor({ host: 'localhost', port, ca: pki.root })).rejects.toThrow(/refused TLS/);
    } finally {
      server.close();
    }
  });

  it('refuses an empty bundle', async () => {
    await expect(postgresTrustAnchor({ host: 'localhost', port: 1, ca: '' })).rejects.toThrow(/no certificates/);
  });
});
