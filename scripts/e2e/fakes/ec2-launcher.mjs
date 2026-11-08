// EC2 launch fake for the e2e stack (E2E_EC2_LAUNCH=1). Floci's EC2 mock keeps
// the API but starts nothing and drops UserData, so an instance the backend
// launches never becomes a box. This proxy sits in front of Floci for EC2 only
// (the backend gets AWS_ENDPOINT_URL_EC2): a RunInstances has its user data
// read for the agent token, and once Floci answers, a stand-in box is started
// through scripts/e2e/box.sh; a TerminateInstances stops that box. A
// StopInstances powers the box off (its agent and its tmux server, as a real
// stop loses both) and a StartInstances boots it again with the same home.
// With <root>/ec2/ignore-stop, a StopInstances is accepted but never reaches
// Floci, so the instance keeps running: a stop EC2 never carried out.
// With <root>/ec2/hold-terminate, DescribeInstances reports a terminated
// instance as shutting-down, so a teardown waits as it would on EC2, where
// shutting down takes minutes; removing the file lets it finish.
//
// Hibernation, which Floci has no notion of: a RunInstances with
// HibernationOptions.Configured=true marks the instance hibernation-capable,
// DescribeInstanceTypes is answered here (every type supports it; the shape
// from CATALOG, else 2 vCPU and 4 GiB), and
// a StopInstances with Hibernate=true freezes the box's agent and tmux server
// (SIGSTOP) instead of killing them, so its sessions survive; the next
// StartInstances thaws them and DescribeInstances reports the stop's reason as
// Client.UserInitiatedHibernate. A hibernate of an instance launched without
// it answers UnsupportedHibernationConfiguration, and with
// <root>/ec2/refuse-hibernate every hibernate answers EC2's "not ready to
// hibernate yet".
//
// Capacity: a RunInstances into a subnet listed in <root>/ec2/no-capacity (one
// id per line, `ctl.sh ec2 no-capacity <subnet>`) answers EC2's
// InsufficientInstanceCapacity. setup gives the stack a second subnet as
// BOX_FALLBACK_SUBNET_IDS so a refused launch has somewhere to go, and every
// RunInstances is appended to <root>/ec2/runs as `<subnet> <type> <result>`,
// and its root volume size logged.
//
// A repo's environment.json requirements: GetInstanceTypesFromInstanceRequirements is
// answered here too, from CATALOG (Floci has no such call).
//
// CreateSnapshot, which Floci does not support, is answered here: a snapshot
// id, with the volume, description and tags recorded in
// <root>/ec2/snapshots/<id>.json for a check to read (a box quarantine takes
// one per volume, backend/src/services/boxQuarantine.ts). Nothing is copied.
//
//   node ec2-launcher.mjs setup <root>   register a box image, print backend env lines
//   node ec2-launcher.mjs serve <root>   run the proxy on 127.0.0.1:$E2E_EC2_PORT
//   node ec2-launcher.mjs bake  <root> [Key=Value ...]
//                                        register a newer box image; tags override
//                                        App=termag, Component=box
//   node ec2-launcher.mjs clear <root>   deregister every box image
//
// Env: E2E_FLOCI_URL, E2E_EC2_PORT, AWS_REGION. Tokens are written only to the
// launched box's agent config (0600) and never logged.
//
// Resize (backend services/boxResize.ts): ModifyInstanceAttribute with an
// InstanceType is answered here (a DryRun with DryRunOperation, as EC2 does
// when the role may make the call), the new type kept in <root>/ec2/<id>.type
// and put into DescribeInstances; DescribeInstanceTypeOfferings offers every
// type asked about. A StartInstances of an instance whose type is listed in
// <root>/ec2/no-capacity-types (`ctl.sh ec2 no-capacity-type <type>`) answers
// InsufficientInstanceCapacity, so the resize walks to the size's next type.
//
// Floci drops image tags: RegisterImage's TagSpecifications are lost, and
// DescribeImages returns no tagSet and ignores tag: filters. CreateTags and
// DescribeTags do work, so bake tags with CreateTags and the proxy puts them
// back on DescribeImages, filtering on them as EC2 does.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const [cmd, root, ...bakeTags] = process.argv.slice(2);
const floci = process.env.E2E_FLOCI_URL;
const region = process.env.AWS_REGION || 'us-east-2';
if (!cmd || !root || !floci) {
  console.error('usage: E2E_FLOCI_URL=... node ec2-launcher.mjs setup|serve|bake|clear <root>');
  process.exit(2);
}
const state = join(root, 'ec2');
mkdirSync(state, { recursive: true });

const sdk = () => createRequire(join(repo, 'backend/package.json'))('@aws-sdk/client-ec2');
const ec2 = () => new (sdk().EC2Client)({ region, endpoint: floci, credentials: { accessKeyId: 'e2e', secretAccessKey: 'e2e' } });

async function bake(extra = []) {
  const { RegisterImageCommand, CreateTagsCommand } = sdk();
  const tags = new Map([['App', 'termag'], ['Component', 'box']]);
  for (const kv of extra) {
    const m = kv.match(/^([^=]+)=(.*)$/);
    if (!m) throw new Error(`bake: tag '${kv}' is not Key=Value`);
    tags.set(m[1], m[2]);
  }
  const stamp = new Date().toISOString().replace(/[-:.Z]/g, '');
  const { ImageId } = await ec2().send(new RegisterImageCommand({
    Name: `termag-box-e2e-${stamp}`,
    Architecture: 'arm64',
    RootDeviceName: '/dev/sda1',
    BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 8 } }],
  }));
  await ec2().send(new CreateTagsCommand({ Resources: [ImageId], Tags: [...tags].map(([Key, Value]) => ({ Key, Value })) }));
  return ImageId;
}

// ── Image tags on DescribeImages ─────────────────────────────────────────

/** The <item> elements directly inside `xml`, nested items left in place. */
function topLevelItems(xml) {
  const items = [];
  let depth = 0, start = -1;
  for (const m of xml.matchAll(/<(\/?)item>/g)) {
    if (!m[1]) { if (depth++ === 0) start = m.index; }
    else if (--depth === 0) items.push(xml.slice(start, m.index + m[0].length));
  }
  return items;
}

/** imageId -> [[key, value]] from Floci's DescribeTags, values still XML-escaped. */
async function imageTags(ids) {
  const tags = new Map(ids.map(id => [id, []]));
  if (ids.length === 0) return tags;
  const q = new URLSearchParams({ Action: 'DescribeTags', Version: '2016-11-15', 'Filter.1.Name': 'resource-id' });
  ids.forEach((id, i) => q.set(`Filter.1.Value.${i + 1}`, id));
  const res = await fetch(floci + '/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q });
  if (!res.ok) throw new Error(`DescribeTags: HTTP ${res.status}`);
  for (const item of topLevelItems((await res.text()).match(/<tagSet>([\s\S]*)<\/tagSet>/)?.[1] ?? '')) {
    const f = k => item.match(new RegExp(`<${k}>([^<]*)</${k}>`))?.[1] ?? '';
    tags.get(f('resourceId'))?.push([f('key'), f('value')]);
  }
  return tags;
}

/** The request's tag:<Key> filters: [key, Set(values)], all of which must match. */
function tagFilters(form) {
  const filters = [];
  for (const [k, v] of form) {
    const n = k.match(/^Filter\.(\d+)\.Name$/)?.[1];
    if (!n || !v.startsWith('tag:')) continue;
    const values = new Set();
    for (const [vk, vv] of form) if (vk.startsWith(`Filter.${n}.Value.`)) values.add(vv);
    filters.push([v.slice(4), values]);
  }
  return filters;
}

const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function withImageTags(xml, form) {
  const set = xml.match(/<imagesSet>([\s\S]*)<\/imagesSet>/);
  if (!set) return xml;
  const items = topLevelItems(set[1]);
  const tags = await imageTags(items.map(i => i.match(/<imageId>([^<]+)<\/imageId>/)?.[1]).filter(Boolean));
  const filters = tagFilters(form);
  const kept = [];
  for (const item of items) {
    const own = tags.get(item.match(/<imageId>([^<]+)<\/imageId>/)?.[1]) ?? [];
    if (!filters.every(([key, values]) => own.some(([k, v]) => unescapeXml(k) === key && values.has(unescapeXml(v))))) continue;
    const tagSet = `<tagSet>${own.map(([k, v]) => `<item><key>${k}</key><value>${v}</value></item>`).join('')}</tagSet>`;
    kept.push(item.replace(/<tagSet>[\s\S]*?<\/tagSet>|<tagSet\/>/, '').replace(/<\/item>$/, `${tagSet}</item>`));
  }
  return xml.replace(set[0], `<imagesSet>${kept.join('')}</imagesSet>`);
}

async function clear() {
  const { DescribeImagesCommand, DeregisterImageCommand } = sdk();
  const { Images = [] } = await ec2().send(new DescribeImagesCommand({ Owners: ['self'] }));
  for (const img of Images) await ec2().send(new DeregisterImageCommand({ ImageId: img.ImageId }));
  return Images.length;
}

async function setup() {
  const { DescribeSubnetsCommand } = sdk();
  const { Subnets = [] } = await ec2().send(new DescribeSubnetsCommand({}));
  const sorted = Subnets.sort((a, b) => a.SubnetId.localeCompare(b.SubnetId));
  const subnet = sorted[0];
  if (!subnet) throw new Error('floci has no default subnet');
  const fallback = sorted.find(s => s.VpcId === subnet.VpcId && s.SubnetId !== subnet.SubnetId) ?? await createSubnet(subnet.VpcId);
  await bake();
  console.log([
    `AWS_ENDPOINT_URL_EC2=http://127.0.0.1:${process.env.E2E_EC2_PORT}`,
    'BOX_RESOURCE_PREFIX=termag-e2e-box',
    'BOX_PERMISSIONS_BOUNDARY_ARN=arn:aws:iam::000000000000:policy/termag-e2e-box-boundary',
    `BOX_VPC_ID=${subnet.VpcId}`,
    `BOX_SUBNET_ID=${subnet.SubnetId}`,
    `BOX_FALLBACK_SUBNET_IDS=${fallback.SubnetId}`,
  ].join('\n'));
}

/** A second subnet in the VPC, for a stack whose Floci came up with only one. */
async function createSubnet(vpcId) {
  const { DescribeVpcsCommand, CreateSubnetCommand } = sdk();
  const { Vpcs = [] } = await ec2().send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
  const [a, b] = (Vpcs[0]?.CidrBlock ?? '172.31.0.0/16').split('.');
  const { Subnet } = await ec2().send(new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: `${a}.${b}.250.0/24` }));
  return Subnet;
}

// ── The proxy ────────────────────────────────────────────────────────────

const log = (...a) => console.log(new Date().toISOString(), '[ec2-launch]', ...a);

/** boxes/<BoxName>, or BoxName.2, .3 when a terminated box already used the name. */
function boxDirName(boxName) {
  const base = (boxName || 'box').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '') || 'box';
  let name = base;
  for (let n = 2; existsSync(join(root, 'boxes', name)); n++) name = `${base}.${n}`;
  return name;
}

/** Every <<'JSON' heredoc in the user data, parsed; a warm box's also carries its pool marker. */
function jsonHeredocs(userData) {
  const script = Buffer.from(userData, 'base64').toString('utf8');
  const docs = [];
  for (const m of script.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON\n/g)) {
    try { docs.push(JSON.parse(m[1])); } catch { /* not ours */ }
  }
  return docs;
}

function agentConfigFrom(userData) {
  const config = jsonHeredocs(userData).find(d => typeof d.token === 'string');
  if (!config) throw new Error('user data has no agent config heredoc');
  return config;
}

/** The warm-pool marker buildWarmCloudInit writes to ~/.termag/pool.json, if this is a pool box. */
function poolMarkerFrom(userData) {
  return jsonHeredocs(userData).find(d => typeof d.poolSpecHash === 'string') ?? null;
}

function tagValue(form, key) {
  for (const [k, v] of form) {
    const t = k.match(/^TagSpecification\.(\d+)\.Tag\.(\d+)\.Key$/);
    if (t && v === key && form.get(`TagSpecification.${t[1]}.ResourceType`) === 'instance') {
      return form.get(`TagSpecification.${t[1]}.Tag.${t[2]}.Value`);
    }
  }
  return undefined;
}

function run(file, args) {
  return new Promise(resolve => execFile(file, args, (err, stdout, stderr) => resolve({ err, out: stdout + stderr })));
}

const noAgent = () => existsSync(join(state, 'no-agent'));
const holdTerminate = () => existsSync(join(state, 'hold-terminate'));

/** Every terminated instance in a DescribeInstances answer, reported as still shutting down. */
const shuttingDown = xml => xml.replace(
  /<instanceState>\s*<code>48<\/code>\s*<name>terminated<\/name>\s*<\/instanceState>/g,
  '<instanceState><code>32</code><name>shutting-down</name></instanceState>');

async function launch(instanceId, form) {
  if (noAgent()) {
    log(`${instanceId}: launched with no agent (ctl.sh ec2 no-agent)`);
    return;
  }
  const userData = form.get('UserData') ?? '';
  const config = agentConfigFrom(userData);
  const pool = config.warm === true ? poolMarkerFrom(userData) : null;
  const env = readFileSync(join(root, 'box.env'), 'utf8');
  const wsUrl = env.match(/^declare -- agent_ws_url="([^"]*)"$/m)?.[1] ?? config.termag_url;
  const name = boxDirName(tagValue(form, 'BoxName'));
  const configDir = join(root, 'boxes', name, 'home', '.termag');
  mkdirSync(configDir, { recursive: true });
  // The stack's agent URL rather than the user data's, so boxes follow E2E_TLS.
  // `warm` makes the agent announce itself as a pool box; cloud-init's pool
  // marker is what a real pool box has on disk, so the box gets it too.
  writeFileSync(join(configDir, 'agent.config.json'),
    JSON.stringify({ termag_url: wsUrl, token: config.token, reconnect_interval_seconds: 2, path_remap: {},
      ...(config.warm === true ? { warm: true } : {}) }, null, 2) + '\n',
    { mode: 0o600 });
  if (pool) writeFileSync(join(configDir, 'pool.json'), JSON.stringify(pool, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(state, instanceId), name + '\n');
  const res = await run('bash', [join(here, '..', 'box.sh'), root, name]);
  log(`${instanceId}: started ${pool ? 'warm pool box' : 'box'} ${name}${res.err ? ` FAILED: ${res.out.trim()}` : ''}`);
}

// RunInstances and StartInstances are answered before box.sh has started the
// agent, so a stop or terminate can arrive mid-boot; both wait for the boot
// recorded here to finish, else they kill nothing and the boot's agent lives on.
const launches = new Map();

/** The box directory an instance runs, once launch() has started it. */
function boxOf(instanceId) {
  const f = join(state, instanceId);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

/** Kill the box's agent and its tmux server, as powering the machine off does. */
async function powerOff(name) {
  const pidFile = join(root, 'pids', `${name}.pid`);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    rmSync(pidFile, { force: true });
  }
  await run(join(root, 'boxes', name, 'bin', 'tmux'), ['kill-server']);
}

async function stop(instanceId) {
  await launches.get(instanceId);
  launches.delete(instanceId);
  const name = boxOf(instanceId);
  if (!name) return;
  await powerOff(name);
  writeFileSync(join(state, `${instanceId}.terminated`), name + '\n');
  rmSync(join(state, instanceId), { force: true });
  log(`${instanceId}: terminated, stopped box ${name}`);
}

async function powerStop(instanceId) {
  await launches.get(instanceId);
  const name = boxOf(instanceId);
  if (!name) return;
  await powerOff(name);
  // The next start is a new boot (box.sh writes a new boot id; agent/box-notice.js).
  rmSync(join(root, 'boxes', name, 'boot_id'), { force: true });
  log(`${instanceId}: stopped, powered box ${name} off`);
}

async function powerStart(instanceId) {
  await launches.get(instanceId);
  const name = boxOf(instanceId);
  if (!name) return;
  if (noAgent()) {
    log(`${instanceId}: started with no agent (ctl.sh ec2 no-agent)`);
    return;
  }
  const res = await run('bash', [join(here, '..', 'box.sh'), root, name]);
  log(`${instanceId}: started, booted box ${name}${res.err ? ` FAILED: ${res.out.trim()}` : ''}`);
}

// ── Hibernation ──────────────────────────────────────────────────────────

const hibernationCapable = id => existsSync(join(state, `${id}.hibernation`));
const hibernatedFile = id => join(state, `${id}.hibernated`);

function ec2Error(code, message) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors>`
    + '<RequestID>e2e-hibernate</RequestID></Response>';
}

const xmlText = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function createSnapshot(form) {
  const volumeId = form.get('VolumeId') ?? '';
  const id = `snap-${Array.from({ length: 17 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
  const tags = {};
  for (const [k, v] of form) {
    const m = k.match(/^TagSpecification\.1\.Tag\.(\d+)\.Key$/);
    if (m) tags[v] = form.get(`TagSpecification.1.Tag.${m[1]}.Value`) ?? '';
  }
  const description = form.get('Description') ?? '';
  const startTime = new Date().toISOString();
  mkdirSync(join(state, 'snapshots'), { recursive: true });
  writeFileSync(join(state, 'snapshots', `${id}.json`), JSON.stringify({ snapshotId: id, volumeId, description, tags, startTime }, null, 2));
  log(`${volumeId}: snapshot ${id} recorded`);
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<CreateSnapshotResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">'
    + `<requestId>e2e-snapshot</requestId><snapshotId>${id}</snapshotId><volumeId>${xmlText(volumeId)}</volumeId>`
    + `<status>pending</status><startTime>${startTime}</startTime><progress></progress><ownerId>000000000000</ownerId>`
    + `<volumeSize>8</volumeSize><description>${xmlText(description)}</description><encrypted>false</encrypted>`
    + '</CreateSnapshotResponse>';
}

/** The type a ModifyInstanceAttribute gave the instance, or null for the one it launched as. */
function modifiedType(id) {
  try { return readFileSync(join(state, `${id}.type`), 'utf8').trim() || null; } catch { return null; }
}

/** The type and subnet RunInstances launched an instance with (recorded at its launch), or nulls. */
function launched(id) {
  try { return JSON.parse(readFileSync(join(state, `${id}.launch.json`), 'utf8')); } catch { return { type: null, subnet: null }; }
}

/** Subnets `ctl.sh ec2 no-start-capacity` has emptied for StartInstances: a stopped box there can't start, on any type. */
function noStartCapacitySubnets() {
  try {
    return new Set(readFileSync(join(state, 'no-start-capacity'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Types `ctl.sh ec2 no-capacity-type` has emptied of capacity, for StartInstances. */
function noCapacityTypes() {
  try {
    return new Set(readFileSync(join(state, 'no-capacity-types'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** DescribeInstances with each resized instance's type as ModifyInstanceAttribute set it. */
function withModifiedTypes(xml) {
  return xml.replace(/<item>\s*<instanceId>(i-[0-9a-f]+)<\/instanceId>[\s\S]*?<\/item>(?=\s*<\/instancesSet>)/g, (item, id) => {
    const type = modifiedType(id);
    return type ? item.replace(/<instanceType>[^<]*<\/instanceType>/, `<instanceType>${type}</instanceType>`) : item;
  });
}

function typeOfferings(form) {
  const types = [...form].filter(([k]) => /^Filter\.\d+\.Name$/.test(k)).flatMap(([k, v]) => {
    if (v !== 'instance-type') return [];
    const n = k.split('.')[1];
    return [...form].filter(([kk]) => kk.startsWith(`Filter.${n}.Value.`)).map(([, vv]) => vv);
  });
  const zone = [...form].find(([k, v]) => /^Filter\.\d+\.Name$/.test(k) && v === 'location');
  const where = zone ? form.get(`Filter.${zone[0].split('.')[1]}.Value.1`) : `${region}a`;
  const items = types.map(t => `<item><instanceType>${t}</instanceType><locationType>availability-zone</locationType><location>${where}</location></item>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<DescribeInstanceTypeOfferingsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">'
    + `<requestId>e2e-offerings</requestId><instanceTypeOfferingSet>${items}</instanceTypeOfferingSet></DescribeInstanceTypeOfferingsResponse>`;
}

/** Subnets `ctl.sh ec2 no-capacity` has emptied of capacity. */
function noCapacitySubnets() {
  try {
    return new Set(readFileSync(join(state, 'no-capacity'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function recordRun(form, result) {
  appendFileSync(join(state, 'runs'), `${form.get('SubnetId') ?? '-'} ${form.get('InstanceType') ?? '-'} ${result}\n`);
  // The root volume asked for (backend boxProvisioner.amiWithDisk), which Floci drops: its volumes are all 8 GB.
  log(`RunInstances ${form.get('InstanceType') ?? '-'}: root volume ${form.get('BlockDeviceMapping.1.Ebs.VolumeSize') ?? '-'} GB, ${result}`);
}

// The Graviton types a repo's environment.json requirements can match (backend
// services/boxRequirements.ts): vCPUs and GiB, as EC2 lists them.
const CATALOG = {
  'm8g.large': [2, 8], 'm8g.xlarge': [4, 16], 'm8g.2xlarge': [8, 32], 'm8g.4xlarge': [16, 64],
  'm7g.large': [2, 8], 'm7g.xlarge': [4, 16], 'm7g.2xlarge': [8, 32], 'm7g.4xlarge': [16, 64],
  'r8g.large': [2, 16], 'r8g.xlarge': [4, 32], 'r8g.2xlarge': [8, 64],
  'r7g.large': [2, 16], 'r7g.xlarge': [4, 32], 'r7g.2xlarge': [8, 64],
  'c8g.large': [2, 4], 'c8g.xlarge': [4, 8], 'c8g.2xlarge': [8, 16],
};

/** DescribeInstanceTypes: every type supports hibernation; a catalog type has its shape, any other 4 GiB. */
function instanceTypes(form) {
  const types = [...form].filter(([k]) => /^InstanceType\.\d+$/.test(k)).map(([, v]) => v);
  const items = types.map(t => {
    const [vcpus, gib] = CATALOG[t] ?? [2, 4];
    return `<item><instanceType>${t}</instanceType><hibernationSupported>true</hibernationSupported>`
      + `<vCpuInfo><defaultVCpus>${vcpus}</defaultVCpus></vCpuInfo><memoryInfo><sizeInMiB>${gib * 1024}</sizeInMiB></memoryInfo></item>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<DescribeInstanceTypesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">'
    + `<requestId>e2e-types</requestId><instanceTypeSet>${items}</instanceTypeSet></DescribeInstanceTypesResponse>`;
}

/**
 * GetInstanceTypesFromInstanceRequirements over CATALOG: the vCPU and memory
 * ranges, and AllowedInstanceType patterns (`r8g.*`), as EC2 filters them. Every
 * request is appended to <root>/ec2/requirements.
 */
function requirementTypes(form) {
  const num = (k, d) => (form.has(k) ? Number(form.get(k)) : d);
  const vMin = num('InstanceRequirements.VCpuCount.Min', 0), vMax = num('InstanceRequirements.VCpuCount.Max', Infinity);
  const mMin = num('InstanceRequirements.MemoryMiB.Min', 0), mMax = num('InstanceRequirements.MemoryMiB.Max', Infinity);
  const allowed = [...form].filter(([k]) => /^InstanceRequirements\.AllowedInstanceType\.\d+$/.test(k))
    .map(([, v]) => new RegExp(`^${v.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`));
  const hits = Object.entries(CATALOG)
    .filter(([t, [v, g]]) => v >= vMin && v <= vMax && g * 1024 >= mMin && g * 1024 <= mMax && (!allowed.length || allowed.some(r => r.test(t))))
    .map(([t]) => t);
  appendFileSync(join(state, 'requirements'), `vcpu ${vMin}-${vMax} memory ${mMin}-${mMax} -> ${hits.join(' ') || '-'}\n`);
  const items = hits.map(t => `<item><instanceType>${t}</instanceType></item>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<GetInstanceTypesFromInstanceRequirementsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">'
    + `<requestId>e2e-requirements</requestId><instanceTypeSet>${items}</instanceTypeSet></GetInstanceTypesFromInstanceRequirementsResponse>`;
}

async function tmuxServerPid(name) {
  const { out } = await run(join(root, 'boxes', name, 'bin', 'tmux'), ['display-message', '-p', '#{pid}']);
  const pid = Number(out.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Freeze the box's agent and tmux server: what a hibernate keeps, nothing runs. */
async function hibernate(instanceId) {
  await launches.get(instanceId);
  const name = boxOf(instanceId);
  if (!name) return;
  const pidFile = join(root, 'pids', `${name}.pid`);
  const agentPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  const tmuxPid = await tmuxServerPid(name);
  if (agentPid) signal(-agentPid, 'SIGSTOP');
  if (tmuxPid) signal(tmuxPid, 'SIGSTOP');
  writeFileSync(hibernatedFile(instanceId), JSON.stringify({ name, agentPid, tmuxPid }) + '\n');
  log(`${instanceId}: hibernated, froze box ${name} (agent ${agentPid ?? '-'}, tmux ${tmuxPid ?? '-'})`);
}

/** Thaw a hibernated box; false when it was not hibernated. */
function resume(instanceId) {
  const f = hibernatedFile(instanceId);
  if (!existsSync(f)) return false;
  const { name, agentPid, tmuxPid } = JSON.parse(readFileSync(f, 'utf8'));
  if (tmuxPid) signal(tmuxPid, 'SIGCONT');
  if (agentPid) signal(-agentPid, 'SIGCONT');
  rmSync(f, { force: true });
  log(`${instanceId}: resumed box ${name} from hibernation`);
  return true;
}

/** Floci reports no StateReason we can trust for a hibernate; say what EC2 would. */
function withHibernateReasons(xml) {
  return xml.replace(/<item>\s*<instanceId>(i-[0-9a-f]+)<\/instanceId>[\s\S]*?<\/item>(?=\s*<\/instancesSet>)/g, (item, id) => {
    if (!existsSync(hibernatedFile(id))) return item;
    const reason = '<stateReason><code>Client.UserInitiatedHibernate</code>'
      + '<message>Client.UserInitiatedHibernate: User initiated hibernate</message></stateReason>';
    const cleaned = item.replace(/<stateReason>[\s\S]*?<\/stateReason>|<stateReason\/>/, '');
    return cleaned.replace(/<\/item>$/, `${reason}</item>`);
  });
}

function stopAccepted(ids) {
  const items = ids.map(id => `<item><instanceId>${id}</instanceId>`
    + '<currentState><code>64</code><name>stopping</name></currentState>'
    + '<previousState><code>16</code><name>running</name></previousState></item>').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<StopInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">'
    + `<requestId>e2e-ignore-stop</requestId><instancesSet>${items}</instancesSet></StopInstancesResponse>`;
}

function serve() {
  const port = Number(process.env.E2E_EC2_PORT);
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const form = new URLSearchParams(body.toString('utf8'));
    const action = form.get('Action');
    if (action === 'DescribeInstanceTypes') {
      res.writeHead(200, { 'content-type': 'text/xml' }).end(instanceTypes(form));
      return;
    }
    if (action === 'CreateSnapshot') {
      res.writeHead(200, { 'content-type': 'text/xml' }).end(createSnapshot(form));
      return;
    }
    if (action === 'GetInstanceTypesFromInstanceRequirements') {
      res.writeHead(200, { 'content-type': 'text/xml' }).end(requirementTypes(form));
      return;
    }
    if (action === 'DescribeInstanceTypeOfferings') {
      res.writeHead(200, { 'content-type': 'text/xml' }).end(typeOfferings(form));
      return;
    }
    if (action === 'ModifyInstanceAttribute' && form.get('InstanceType.Value')) {
      const id = form.get('InstanceId');
      const type = form.get('InstanceType.Value');
      if (form.get('DryRun') === 'true') {
        res.writeHead(412, { 'content-type': 'text/xml' }).end(ec2Error('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.'));
        return;
      }
      writeFileSync(join(state, `${id}.type`), type);
      log(`${id}: instance type set to ${type}`);
      res.writeHead(200, { 'content-type': 'text/xml' }).end('<?xml version="1.0" encoding="UTF-8"?>'
        + '<ModifyInstanceAttributeResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>e2e-modify</requestId><return>true</return></ModifyInstanceAttributeResponse>');
      return;
    }
    if (action === 'StartInstances') {
      const ids = [...form].filter(([k]) => /^InstanceId\.\d+$/.test(k)).map(([, v]) => v);
      // Its type now: the one a resize (or a start's retype) set, else the one it launched as.
      const typeOf = id => modifiedType(id) ?? launched(id).type;
      const full = ids.find(id => typeOf(id) && noCapacityTypes().has(typeOf(id)));
      if (full) {
        log(`StartInstances ${full} as ${typeOf(full)}: no capacity (ctl.sh ec2 no-capacity-type)`);
        res.writeHead(500, { 'content-type': 'text/xml' }).end(ec2Error('InsufficientInstanceCapacity',
          `We currently do not have sufficient ${typeOf(full)} capacity in the Availability Zone you requested.`));
        return;
      }
      // A zone with no room for anything: a stopped box can't move, so only a box elsewhere can start.
      const zoneFull = ids.find(id => launched(id).subnet && noStartCapacitySubnets().has(launched(id).subnet));
      if (zoneFull) {
        log(`StartInstances ${zoneFull} in ${launched(zoneFull).subnet}: no capacity (ctl.sh ec2 no-start-capacity)`);
        res.writeHead(500, { 'content-type': 'text/xml' }).end(ec2Error('InsufficientInstanceCapacity',
          `We currently do not have sufficient ${typeOf(zoneFull) ?? 'instance'} capacity in the Availability Zone you requested.`));
        return;
      }
    }
    const hibernating = action === 'StopInstances' && form.get('Hibernate') === 'true';
    if (hibernating) {
      const ids = [...form].filter(([k]) => /^InstanceId\.\d+$/.test(k)).map(([, v]) => v);
      const refused = ids.find(id => !hibernationCapable(id));
      if (refused) {
        log(`${refused}: hibernate refused, launched without HibernationOptions`);
        res.writeHead(400, { 'content-type': 'text/xml' }).end(ec2Error('UnsupportedHibernationConfiguration',
          `The instance ${refused} is not configured for hibernation.`));
        return;
      }
      if (existsSync(join(state, 'refuse-hibernate'))) {
        log(`${ids.join(',')}: hibernate refused (ctl.sh ec2 refuse-hibernate)`);
        res.writeHead(400, { 'content-type': 'text/xml' }).end(ec2Error('UnsupportedOperation',
          'Instance is not ready to hibernate yet, please try again later.'));
        return;
      }
      form.delete('Hibernate');
    }
    if (action === 'RunInstances' && noCapacitySubnets().has(form.get('SubnetId'))) {
      log(`RunInstances ${form.get('InstanceType')} in ${form.get('SubnetId')}: no capacity (ctl.sh ec2 no-capacity)`);
      recordRun(form, 'InsufficientInstanceCapacity');
      res.writeHead(500, { 'content-type': 'text/xml' }).end(ec2Error('InsufficientInstanceCapacity',
        `We currently do not have sufficient ${form.get('InstanceType')} capacity in the Availability Zone you requested.`));
      return;
    }
    if (action === 'StopInstances' && existsSync(join(state, 'ignore-stop'))) {
      const ids = [...form].filter(([k]) => /^InstanceId\.\d+$/.test(k)).map(([, v]) => v);
      log(`${ids.join(',')}: stop accepted and ignored (ctl.sh ec2 ignore-stop)`);
      res.writeHead(200, { 'content-type': 'text/xml' }).end(stopAccepted(ids));
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    let upstream;
    try {
      const sent = hibernating ? Buffer.from(form.toString()) : body;
      upstream = await fetch(floci + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : sent });
    } catch (err) {
      res.writeHead(502).end(String(err));
      return;
    }
    let text = await upstream.text();
    if (upstream.ok && action === 'DescribeInstances') text = withModifiedTypes(withHibernateReasons(text));
    if (upstream.ok && action === 'DescribeImages') {
      try {
        text = await withImageTags(text, form);
      } catch (err) {
        log(`DescribeImages: could not add image tags: ${err.message}`);
        res.writeHead(502).end(String(err));
        return;
      }
    }
    if (upstream.ok && action === 'DescribeInstances' && holdTerminate()) text = shuttingDown(text);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/xml' }).end(text);
    if (action === 'RunInstances') recordRun(form, upstream.ok ? 'launched' : `http-${upstream.status}`);
    if (!upstream.ok) return;
    try {
      if (action === 'RunInstances') {
        const ids = new Set([...text.matchAll(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/g)].map(m => m[1]));
        for (const id of ids) {
          if (form.get('HibernationOptions.Configured') === 'true') writeFileSync(join(state, `${id}.hibernation`), '');
          writeFileSync(join(state, `${id}.launch.json`), JSON.stringify({ type: form.get('InstanceType') ?? null, subnet: form.get('SubnetId') ?? null }));
          launches.set(id, launch(id, form).catch(err => log(`${id}: launch failed: ${err.message}`)));
        }
        await Promise.all([...ids].map(id => launches.get(id)));
      } else if (action === 'TerminateInstances') {
        for (const [k, v] of form) if (/^InstanceId\.\d+$/.test(k)) { resume(v); await stop(v); }
      } else if (action === 'StopInstances') {
        for (const [k, v] of form) {
          if (!/^InstanceId\.\d+$/.test(k)) continue;
          if (hibernating) await hibernate(v); else await powerStop(v);
        }
      } else if (action === 'StartInstances') {
        for (const [k, v] of form) {
          if (!/^InstanceId\.\d+$/.test(k)) continue;
          if (resume(v)) continue;
          launches.set(v, powerStart(v).catch(err => log(`${v}: start failed: ${err.message}`)));
          await launches.get(v);
        }
      }
    } catch (err) {
      log(`${action} follow-up failed: ${err.message}`);
    }
  }).listen(port, '127.0.0.1', () => log(`proxying EC2 to ${floci} on 127.0.0.1:${port}`));
}

try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'serve') serve();
  else if (cmd === 'bake') console.log(await bake(bakeTags));
  else if (cmd === 'clear') console.log(`deregistered ${await clear()} image(s)`);
  else throw new Error(`unknown command ${cmd}`);
} catch (err) {
  console.error(`[ec2-launch] ${err.message}`);
  process.exit(1);
}
