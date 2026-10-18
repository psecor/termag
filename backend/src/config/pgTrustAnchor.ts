/**
 * The one CA certificate Prisma's schema engine can verify the server with.
 *
 * node-postgres (the server's driver adapter, dbGuard) reads every certificate
 * in a CA file. Prisma's engine (`prisma db push`, via `sslcert`) reads only the
 * first. Amazon's global RDS bundle starts with another region's root, so handing
 * it to Prisma fails with P1011 "unable to get local issuer certificate".
 *
 * So, before Prisma connects: open a TLS session to the server the way libpq does
 * (SSLRequest, then TLS), verify it against the whole bundle, and take the root
 * that anchors the verified chain. That root, alone in a file, is what Prisma gets.
 * It is always one of the bundle's certificates, so nothing is trusted that the
 * bundle did not already trust; the IAM token is never sent on this connection.
 */
import { connect as netConnect, isIP } from 'net';
import { connect as tlsConnect, type DetailedPeerCertificate } from 'tls';

// Int32 length 8, Int32 request code 80877103 (Postgres protocol, SSLRequest).
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

export function pemCertificates(bundle: string): string[] {
  return bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function derOf(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
}

/** The top of a verified chain: Node completes it from the `ca` store, ending in a self-issued root. */
export function chainRoot(cert: DetailedPeerCertificate): DetailedPeerCertificate {
  let c = cert;
  const seen = new Set<string>();
  while (c.issuerCertificate && c.issuerCertificate.fingerprint256 !== c.fingerprint256 && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    c = c.issuerCertificate;
  }
  return c;
}

export interface TrustAnchorTarget {
  host: string;
  port: number;
  /** PEM bundle the server must verify against (every certificate is used). */
  ca: string;
  timeoutMs?: number;
}

/** The bundle certificate (PEM) that anchors the server's verified chain. */
export function postgresTrustAnchor({ host, port, ca, timeoutMs = 10_000 }: TrustAnchorTarget): Promise<string> {
  const bundle = pemCertificates(ca);
  if (bundle.length === 0) return Promise.reject(new Error('the CA bundle has no certificates'));

  return new Promise((resolve, reject) => {
    const raw = netConnect({ host, port });
    let settled = false;
    const finish = (err: Error | null, pem?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      raw.destroy();
      if (err) reject(err); else resolve(pem!);
    };
    const timer = setTimeout(() => finish(new Error(`TLS probe to ${host}:${port} timed out`)), timeoutMs);

    raw.once('error', err => finish(err));
    raw.once('connect', () => raw.write(SSL_REQUEST));
    raw.once('data', reply => {
      if (reply[0] !== 0x53) {
        finish(new Error(`${host}:${port} refused TLS (SSLRequest answered ${JSON.stringify(String.fromCharCode(reply[0]))})`));
        return;
      }
      // SNI takes names only; the hostname is still checked against the certificate either way.
      const secure = tlsConnect({ socket: raw, servername: isIP(host) ? undefined : host, host, ca: bundle, rejectUnauthorized: true });
      secure.once('error', err => finish(err));
      secure.once('secureConnect', () => {
        const root = chainRoot(secure.getPeerCertificate(true));
        const der = root.raw?.toString('base64');
        const match = bundle.find(pem => derOf(pem) === der);
        secure.destroy();
        if (!match) {
          finish(new Error(`the chain from ${host} verified, but its root (${root.subject?.CN ?? 'unknown'}) is not a bundle certificate`));
          return;
        }
        finish(null, `${match}\n`);
      });
    });
  });
}
