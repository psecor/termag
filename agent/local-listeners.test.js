'use strict';
// listenersOn, procAddress and dockerPublisher are tested through
// browser-guest.test.js, which re-exports them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listenRows, takersOf, dockerBindings, dockerServiceBindings } = require('./local-listeners');

test('listenRows: the LISTEN sockets on a port, with owner and inode', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const files = {
    '/p/net/tcp': `${header}   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 11 1 0\n   1: 0100007F:0BB8 0100007F:9000 01 00000000:00000000 00:00000000 00000000  1001        0 12 1 0\n   2: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 13 1 0\n`,
    '/p/net/tcp6': `${header}   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 14 1 0\n`,
  };
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
  assert.deepEqual(listenRows(3000, read, '/p'), [
    { table: 'tcp', hex: '0100007F', addr: '127.0.0.1', uid: 1001, inode: '11' },
    { table: 'tcp6', hex: '00000000000000000000000001000000', addr: 'other-v6', uid: 0, inode: '14' },
  ]);
  assert.deepEqual(listenRows(3000, read, '/missing'), []);
});

test('takersOf: the address\'s own sockets, else the wildcards, by family', () => {
  const r = (addr) => ({ addr });
  assert.deepEqual(takersOf([r('0.0.0.0'), r('127.0.0.1'), r('::')], '127.0.0.1'), [r('127.0.0.1')]);
  assert.deepEqual(takersOf([r('::'), r('0.0.0.0')], '127.0.0.1'), [r('0.0.0.0')]);
  assert.deepEqual(takersOf([r('::'), r('127.0.0.2')], '127.0.0.1'), [r('::')]);
  assert.deepEqual(takersOf([r('0.0.0.0'), r('::')], '::1'), [r('::')], '0.0.0.0 takes no IPv6');
  assert.deepEqual(takersOf([r('0.0.0.0')], '::1'), []);
});

test('dockerBindings: every container\'s TCP bindings of the port, with its compose dir', async () => {
  const list = [
    { Ports: [{ IP: '0.0.0.0', PublicPort: 80, Type: 'tcp' }, { IP: '::', PublicPort: 80, Type: 'tcp' }, { IP: '0.0.0.0', PublicPort: 443, Type: 'tcp' }], Labels: { 'com.docker.compose.project.working_dir': '/h/a' } },
    { Ports: [{ IP: '127.0.0.2', PublicPort: 80, Type: 'tcp' }, { PrivatePort: 80 }] },
    // UDP, or a binding without a type: not a TCP publish.
    { Ports: [{ IP: '127.0.0.1', PublicPort: 80, Type: 'udp' }, { IP: '127.0.0.3', PublicPort: 80 }], Labels: { 'com.docker.compose.project.working_dir': '/h/b' } },
  ];
  assert.deepEqual(await dockerBindings(80, async () => list), [
    { ip: '0.0.0.0', workingDir: '/h/a' }, { ip: '::', workingDir: '/h/a' }, { ip: '127.0.0.2', workingDir: '' },
  ]);
  assert.equal(await dockerBindings(80, async () => null), null);
});

test('dockerServiceBindings: a compose service\'s TCP publishes, asked for by its label', async () => {
  let asked = '';
  const list = [
    { Ports: [{ IP: '127.0.0.2', PublicPort: 80, PrivatePort: 3000, Type: 'tcp' }, { PrivatePort: 6081, Type: 'tcp' }], Labels: { 'com.docker.compose.project.working_dir': '/h/a/dev-stack' } },
    { Ports: [{ IP: '127.0.0.1', PublicPort: 8090, Type: 'tcp' }, { IP: '127.0.0.1', PublicPort: 53, Type: 'udp' }] },
  ];
  const get = async (p) => { asked = p; return list; };
  assert.deepEqual(await dockerServiceBindings('varnish-fastly', get), [
    { ip: '127.0.0.2', port: 80, workingDir: '/h/a/dev-stack' }, { ip: '127.0.0.1', port: 8090, workingDir: '' },
  ]);
  assert.deepEqual(JSON.parse(decodeURIComponent(asked.split('filters=')[1])), { label: ['com.docker.compose.service=varnish-fastly'] });
  assert.equal(await dockerServiceBindings('varnish-fastly', async () => null), null);
});

// Bugbot on #998 (bea08d69): a socket bound to ::1 alone is the IPv6 loopback, which a health probe reaches,
// so whose it is can be asked too (port-guard.js reads ::1 the same way).
test('listenersOn finds a listener bound to ::1 alone, with its owner', () => {
  const { listenersOn } = require('./local-listeners');
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const files = {
    '/proc/net/tcp': header,
    '/proc/net/tcp6': `${header}   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 14 1 0\n`,
  };
  const io = {
    readFileSync: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    readdirSync: (d) => (d === '/proc' ? ['42'] : d === '/proc/42/fd' ? ['3'] : []),
    readlinkSync: (l) => (l === '/proc/42/fd/3' ? 'socket:[14]' : l === '/proc/42/cwd' ? '/elsewhere' : ''),
  };
  assert.deepEqual(listenersOn('::1', 3000, io), [{ pid: 42, cwd: '/elsewhere' }]);
  assert.deepEqual(listenersOn('::1', 3000, io, { exactOnly: true }), [{ pid: 42, cwd: '/elsewhere' }]);
});
