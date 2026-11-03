/**
 * A box size given as requirements rather than a preset: `{ "vcpu": 4,
 * "memoryGiB": 32 }` in a repository's `.termag/environment.json`
 * (services/repoEnvironment.ts). The numbers are minimums. EC2 does the
 * matching (GetInstanceTypesFromInstanceRequirements, arm64 only, within
 * REQUIREMENT_FAMILIES); termag only orders what EC2 returns, cheapest shape
 * first, and walks that list on a capacity refusal as it walks a preset's
 * fallbacks (boxProvisioner.withInstanceTypes).
 *
 * The order is by shape, not by a price table: within these Graviton
 * families the on-demand price grows with vCPUs and then with memory, so the
 * fewest vCPUs, then the least memory, is the cheapest type that fits; at the
 * same shape the newer generation goes first. 4 vCPU and 32 GiB is
 * r8g.xlarge, then r7g.xlarge, then m8g.2xlarge and m7g.2xlarge.
 *
 * A requirement out of BOX_REQUIREMENT_LIMITS, or one EC2 has no type for,
 * is left out with a warning and the box takes its default size: never a
 * failed launch. The warm pool holds presets only, so a requirements box
 * launches cold unless its first type is a preset's (then it is that preset).
 *
 * Instance.size records a requirements box as `<vcpu>vcpu-<memory>gib`
 * (requirementsLabel). The lists and the pickers show such a box by its
 * instance type alone (r8g.xlarge); a preset keeps its name.
 */
import {
  DescribeInstanceTypesCommand,
  EC2Client,
  GetInstanceTypesFromInstanceRequirementsCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import type { InstanceTypeChoice } from './boxProvisioner';
import { awsClientConfig, getBoxConfig } from './boxProvisioner';
import { BOX_SIZES, boxSizeSpec, type BoxRequirements, type BoxSize } from './boxSize';

export type { BoxRequirements };

/** The largest box a requirement may ask for: large's vCPUs, and large's memory (which r8g.xlarge has at 4 vCPU). */
export const BOX_REQUIREMENT_LIMITS = { maxVcpu: 8, maxMemoryGiB: 32 } as const;

/**
 * The instance families a requirements box may launch as, preferred first:
 * Graviton (arm64, which the AMI needs) general purpose and memory
 * optimized, this generation then the last. Compute optimized (c) is left
 * out: under BOX_REQUIREMENT_LIMITS it only ever adds less memory per vCPU.
 * The box-resize role's type list must allow the same families.
 */
export const REQUIREMENT_FAMILIES = ['m8g', 'r8g', 'm7g', 'r7g'] as const;

/** A launch walks the first type and at most this many fallbacks. */
const MAX_FALLBACKS = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** A environment.json size as requirements: whole vCPUs and GiB, both at least 1 and within the limits. */
export function parseRequirements(value: unknown): { ok: true; requirements: BoxRequirements } | { ok: false; why: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, why: 'not a size or a { "vcpu", "memoryGiB" } object' };
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(k => k !== 'vcpu' && k !== 'memoryGiB');
  if (extra.length) return { ok: false, why: `${extra.map(k => `"${k}"`).join(', ')} is not a requirement termag knows (vcpu, memoryGiB)` };
  const { vcpu, memoryGiB } = record;
  if (!Number.isInteger(vcpu) || (vcpu as number) < 1) return { ok: false, why: '"vcpu" must be a whole number of at least 1' };
  if (!Number.isInteger(memoryGiB) || (memoryGiB as number) < 1) return { ok: false, why: '"memoryGiB" must be a whole number of at least 1' };
  if ((vcpu as number) > BOX_REQUIREMENT_LIMITS.maxVcpu) return { ok: false, why: `${vcpu} vCPU is over the ${BOX_REQUIREMENT_LIMITS.maxVcpu} vCPU limit` };
  if ((memoryGiB as number) > BOX_REQUIREMENT_LIMITS.maxMemoryGiB) return { ok: false, why: `${memoryGiB} GiB is over the ${BOX_REQUIREMENT_LIMITS.maxMemoryGiB} GiB limit` };
  return { ok: true, requirements: { vcpu: vcpu as number, memoryGiB: memoryGiB as number } };
}

/** Instance.size for a requirements box: `4vcpu-32gib`. */
export function requirementsLabel(r: BoxRequirements): string {
  return `${r.vcpu}vcpu-${r.memoryGiB}gib`;
}

const LABEL_RE = /^(\d{1,3})vcpu-(\d{1,4})gib$/;

/** The requirements an Instance.size records, or null for a preset (or anything else). */
export function parseRequirementsLabel(size: string | null | undefined): BoxRequirements | null {
  const m = size ? LABEL_RE.exec(size) : null;
  if (!m) return null;
  const parsed = parseRequirements({ vcpu: Number(m[1]), memoryGiB: Number(m[2]) });
  return parsed.ok ? parsed.requirements : null;
}

/** "4 vCPU, 32 GB", as the pickers word a shape. */
export function describeRequirements(r: BoxRequirements): string {
  return `${r.vcpu} vCPU, ${r.memoryGiB} GB`;
}

/** What EC2 says about one candidate. */
export interface CandidateType {
  type: string;
  vcpu: number;
  memoryMiB: number;
}

/** `m8g` → generation 8, family m; null for anything outside REQUIREMENT_FAMILIES. */
function familyOf(type: string): { family: string; generation: number; preference: number } | null {
  const family = type.split('.')[0];
  const preference = (REQUIREMENT_FAMILIES as readonly string[]).indexOf(family);
  if (preference < 0) return null;
  return { family, generation: Number(/\d+/.exec(family)?.[0] ?? 0), preference };
}

/**
 * EC2's matches as a launch order: only REQUIREMENT_FAMILIES and only those
 * that meet the requirements (a guard on EC2's own filter), fewest vCPUs
 * first, then least memory, then the newer generation, then the family
 * preference; the first type and MAX_FALLBACKS more. Pure.
 */
export function orderCandidates(r: BoxRequirements, candidates: readonly CandidateType[]): string[] {
  const fits = candidates
    .map(c => ({ ...c, family: familyOf(c.type) }))
    .filter((c): c is CandidateType & { family: NonNullable<ReturnType<typeof familyOf>> } =>
      !!c.family && c.vcpu >= r.vcpu && c.memoryMiB >= r.memoryGiB * 1024
      && c.vcpu <= BOX_REQUIREMENT_LIMITS.maxVcpu && c.memoryMiB <= BOX_REQUIREMENT_LIMITS.maxMemoryGiB * 1024);
  fits.sort((a, b) => a.vcpu - b.vcpu || a.memoryMiB - b.memoryMiB
    || b.family.generation - a.family.generation || a.family.preference - b.family.preference || a.type.localeCompare(b.type));
  return [...new Set(fits.map(c => c.type))].slice(0, MAX_FALLBACKS + 1);
}

/** The preset whose primary type a resolution starts with, so the box can be that preset (and come from the warm pool). */
export function presetFor(types: readonly string[], env: NodeJS.ProcessEnv = process.env): BoxSize | null {
  return BOX_SIZES.find(size => boxSizeSpec(size, env).types[0] === types[0]) ?? null;
}

export interface RequirementsAws {
  /** GetInstanceTypesFromInstanceRequirements' type names, every page. */
  matching(r: BoxRequirements): Promise<string[]>;
  /** DescribeInstanceTypes for those names. */
  describe(types: readonly string[]): Promise<CandidateType[]>;
}

export type Resolution =
  | { ok: true; choice: InstanceTypeChoice; preset: BoxSize | null }
  | { ok: false; warning: string };

export interface RequirementsResolver {
  resolve(r: BoxRequirements): Promise<Resolution>;
}

/** Resolutions cached by requirements for CACHE_TTL_MS; a failure isn't cached, so the next box asks again. */
export function createRequirementsResolver(aws: () => RequirementsAws | null, opts: { now?: () => number; ttlMs?: number } = {}): RequirementsResolver {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, { at: number; types: string[] }>();
  return {
    async resolve(r) {
      const label = describeRequirements(r);
      const key = requirementsLabel(r);
      const hit = cache.get(key);
      let types = hit && now() - hit.at < ttl ? hit.types : null;
      if (!types) {
        const client = aws();
        if (!client) return { ok: false, warning: `${label}: this orchestrator has no box provisioning to match it with` };
        try {
          const names = await client.matching(r);
          types = names.length ? orderCandidates(r, await client.describe(names)) : [];
        } catch (err) {
          return { ok: false, warning: `${label}: EC2 could not match it (${err instanceof Error ? err.message : String(err)})` };
        }
        if (!types.length) return { ok: false, warning: `${label}: no ${REQUIREMENT_FAMILIES.join('/')} type has that` };
        cache.set(key, { at: now(), types });
      }
      const [type, ...fallbacks] = types;
      return { ok: true, choice: { type, fallbacks }, preset: presetFor(types) };
    },
  };
}

function ec2Requirements(): RequirementsAws | null {
  const cfg = getBoxConfig();
  if (!cfg) return null;
  const ec2 = new EC2Client(awsClientConfig(cfg));
  return {
    async matching(r) {
      const names: string[] = [];
      let NextToken: string | undefined;
      do {
        const res = await ec2.send(new GetInstanceTypesFromInstanceRequirementsCommand({
          ArchitectureTypes: ['arm64'],
          VirtualizationTypes: ['hvm'],
          InstanceRequirements: {
            VCpuCount: { Min: r.vcpu, Max: BOX_REQUIREMENT_LIMITS.maxVcpu },
            MemoryMiB: { Min: r.memoryGiB * 1024, Max: BOX_REQUIREMENT_LIMITS.maxMemoryGiB * 1024 },
            AllowedInstanceTypes: REQUIREMENT_FAMILIES.map(f => `${f}.*`),
            BareMetal: 'excluded',
            BurstablePerformance: 'excluded',
          },
          NextToken,
        }));
        for (const t of res.InstanceTypes ?? []) if (t.InstanceType) names.push(t.InstanceType);
        NextToken = res.NextToken;
      } while (NextToken);
      return names;
    },
    async describe(types) {
      const out: CandidateType[] = [];
      // DescribeInstanceTypes takes 100 names a call.
      for (let i = 0; i < types.length; i += 100) {
        const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: types.slice(i, i + 100) as _InstanceType[] }));
        for (const t of res.InstanceTypes ?? []) {
          if (t.InstanceType && t.VCpuInfo?.DefaultVCpus && t.MemoryInfo?.SizeInMiB) {
            out.push({ type: t.InstanceType, vcpu: t.VCpuInfo.DefaultVCpus, memoryMiB: t.MemoryInfo.SizeInMiB });
          }
        }
      }
      return out;
    },
  };
}

export const requirementsResolver: RequirementsResolver = createRequirementsResolver(ec2Requirements);
