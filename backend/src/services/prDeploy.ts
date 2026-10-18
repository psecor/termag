/**
 * How a termag merge reaches prod, for the PR pipeline's "Merged, not
 * deployed" lane. Since the orchestrator
 * moved behind its ASG, a deploy is a bake: publish-ami.yml checks main every
 * three hours, bakes an orchestrator image when its inputs changed, and that
 * bake on main deploys itself (deploy-orchestrator, instance refresh). So a
 * merge that is not on prod is either not in the newest orchestrator image
 * yet, or in it and still rolling out.
 *
 *   - `newestOrchestratorImage`: the commit the newest Component=orchestrator
 *     AMI was baked from (its TermagSha tag), through the box provisioner's EC2
 *     client: both images are baked into the same account. null when box
 *     provisioning is not configured or EC2 cannot be read.
 *   - `bakeRuns`: the Publish AMI runs in flight, read as the user;
 *   - `dispatchBake`: "Bake & deploy now", a workflow_dispatch of publish-ami.yml
 *     on main with target=orchestrator, as the user. GitHub decides whether
 *     they may (write access to the repository).
 */

import { DescribeImagesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { amiTermagSha, awsClientConfig, getBoxConfig } from './boxProvisioner';
import { GithubApiError } from './githubCredential';
import { TERMAG_REPO } from './prPipeline';
import { headers } from './prPipelineGithub';
import { githubReason } from './prReview';
import { ttlMemo } from './ttlMemo';

type Fetch = typeof fetch;
const API = 'https://api.github.com';

export const BAKE_WORKFLOW = 'publish-ami.yml';
export const BAKE_WORKFLOW_URL = `https://github.com/${TERMAG_REPO}/actions/workflows/${BAKE_WORKFLOW}`;
export const DEPLOY_BRANCH = 'main';

// ── The newest orchestrator image ────────────────────────────────────────────

export interface OrchestratorImage { sha: string | null; createdAt: string | null }

/** The newest image of a DescribeImages answer, by CreationDate, with its TermagSha. */
export function newestImage(images: { CreationDate?: string; Tags?: { Key?: string; Value?: string }[] }[]): OrchestratorImage | null {
  const dated = images.filter(i => i.CreationDate);
  if (dated.length === 0) return null;
  dated.sort((a, b) => (b.CreationDate! < a.CreationDate! ? -1 : 1));
  return { sha: amiTermagSha(dated[0]), createdAt: dated[0].CreationDate ?? null };
}

async function loadOrchestratorImage(): Promise<OrchestratorImage | null> {
  const cfg = getBoxConfig();
  if (!cfg) return null;
  const ec2 = new EC2Client(awsClientConfig(cfg));
  const res = await ec2.send(new DescribeImagesCommand({
    Filters: [
      { Name: 'tag:App', Values: ['termag'] },
      { Name: 'tag:Component', Values: ['orchestrator'] },
      { Name: 'state', Values: ['available'] },
    ],
    Owners: ['self'],
  }));
  return newestImage(res.Images ?? []);
}

// A bake lands at most every three hours; five minutes keeps a fresh bake visible soon after.
const IMAGE_CACHE_MS = 5 * 60_000;
let imageLoader: (() => Promise<OrchestratorImage | null>) | null = null;

export async function newestOrchestratorImage(): Promise<OrchestratorImage | null> {
  if (!imageLoader) imageLoader = ttlMemo(loadOrchestratorImage, IMAGE_CACHE_MS);
  try {
    return await imageLoader();
  } catch (err) {
    console.warn('[PRS] could not read the newest orchestrator AMI:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Test seam. */
export function _resetOrchestratorImage(): void {
  imageLoader = null;
}

// ── Bake runs ────────────────────────────────────────────────────────────────

export interface BakeRun { url: string; status: string; event: string; createdAt: string | null }

/** Publish AMI runs on main that are queued or running, newest first; null when GitHub could not say. */
export async function bakeRuns(token: string, fetchImpl: Fetch = fetch): Promise<BakeRun[] | null> {
  try {
    const res = await fetchImpl(`${API}/repos/${TERMAG_REPO}/actions/workflows/${BAKE_WORKFLOW}/runs?branch=${DEPLOY_BRANCH}&per_page=10`, { headers: headers(token) });
    if (!res.ok) return null;
    const body = await res.json() as { workflow_runs?: Record<string, unknown>[] };
    return (body.workflow_runs ?? [])
      .filter(r => r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting' || r.status === 'pending')
      .map(r => ({
        url: typeof r.html_url === 'string' ? r.html_url : BAKE_WORKFLOW_URL,
        status: String(r.status),
        event: String(r.event ?? ''),
        createdAt: typeof r.created_at === 'string' ? r.created_at : null,
      }));
  } catch {
    return null;
  }
}

/**
 * Starts a bake of main's orchestrator image, which deploys itself when it
 * succeeds. GitHub answers 204 with no run id; the next bakeRuns shows it.
 */
export async function dispatchBake(token: string, fetchImpl: Fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${API}/repos/${TERMAG_REPO}/actions/workflows/${BAKE_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: DEPLOY_BRANCH, inputs: { target: 'orchestrator' } }),
  });
  if (res.ok) return;
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const reason = githubReason(body);
  // A 404 here is GitHub's answer to a token without write access to the repository.
  const why = res.status === 404 ? 'your GitHub account cannot run workflows in example-org/termag' : reason ?? `HTTP ${res.status}`;
  throw new GithubApiError(`GitHub did not start the bake: ${why}`, res.status === 404 ? 403 : res.status);
}
