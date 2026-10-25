/**
 * What a finished run leaves behind, and telling the owner: the run branch's state (commits beyond the default branch,
 * pushed or not, uncommitted changes) read with the box's `git-branch-state`
 * RPC, stored on the run row for the run table, and one message to the
 * project's Slack channel (the channel every project gets at creation) when
 * the automation asks for it (off until the owner opts in). Only termag's
 * own words and the run's STATUS summary go to Slack, never pane or
 * transcript text beyond that line, and that summary is the model's: it
 * read untrusted notes, issues and repository text. So the message holds a
 * summary only when it carries nothing secret-shaped (askPublish.ts
 * findSecretsInText, as Collab posts do), links a PR only in the project's
 * own repository, and asks Slack not to unfurl anything.
 */
import type { AutomationRun } from '@prisma/client';
import { sendForProject } from '../agentRegistry';
import { getSlackApp } from '../../slack/app';
import { findSecretsInText } from '../askPublish';
import { slackEscape, webBase, sessionLink } from '../briefing/slack';

export interface BranchSummary {
  /** Commits on the run branch that origin/<default> lacks; null when unknown. */
  commitsAhead: number | null;
  /** The branch has an upstream and nothing unpushed. */
  pushed: boolean | null;
  dirty: boolean | null;
}

/** Read the run branch's state off the box. Never throws; unknown fields stay null. */
export async function summarizeBranch(host: { userId: string; instanceId: string }, cwd: string): Promise<BranchSummary> {
  const raw = await sendForProject(host, 'git-branch-state', { cwd }, 20_000).catch(() => null) as
    { aheadOfBase?: unknown; upstream?: unknown; ahead?: unknown; abKnown?: unknown; dirty?: unknown } | null;
  return branchSummaryFrom(raw);
}

/**
 * `pushed` is known only when git printed an ahead/behind line for the
 * upstream (`abKnown`): the agent defaults `ahead` to 0 when the
 * remote-tracking ref is gone, which is not "pushed".
 */
export function branchSummaryFrom(raw: { aheadOfBase?: unknown; upstream?: unknown; ahead?: unknown; abKnown?: unknown; dirty?: unknown } | null): BranchSummary {
  if (!raw) return { commitsAhead: null, pushed: null, dirty: null };
  const commitsAhead = typeof raw.aheadOfBase === 'number' && Number.isInteger(raw.aheadOfBase) && raw.aheadOfBase >= 0 ? raw.aheadOfBase : null;
  const hasUpstream = typeof raw.upstream === 'string' && raw.upstream.length > 0;
  const abKnown = raw.abKnown !== false;
  const pushed = hasUpstream ? (abKnown && typeof raw.ahead === 'number' ? raw.ahead === 0 : null) : commitsAhead === null ? null : false;
  return { commitsAhead, pushed, dirty: typeof raw.dirty === 'boolean' ? raw.dirty : null };
}

/** "3 commits, pushed", "1 commit, not pushed", "no changes", "uncommitted changes": the run table's words. */
export function changesLabel(s: BranchSummary): string {
  const parts: string[] = [];
  if (s.commitsAhead === null) {
    if (s.dirty) parts.push('uncommitted changes');
    return parts.join(', ') || 'unknown';
  }
  if (s.commitsAhead === 0 && !s.dirty) return 'no changes';
  if (s.commitsAhead > 0) parts.push(`${s.commitsAhead} commit${s.commitsAhead === 1 ? '' : 's'}${s.pushed === true ? ', pushed' : s.pushed === false ? ', not pushed' : ''}`);
  if (s.dirty) parts.push('uncommitted changes');
  return parts.join(', ');
}

export interface ReportInput {
  projectId: string;
  projectName: string;
  /** The project's repository; a PR is linked only when it lives there. */
  repoUrl: string | null;
  run: Pick<AutomationRun, 'state' | 'reason' | 'summary' | 'prUrl' | 'scheduledFor' | 'costUsd'> & { workstream: string | null };
  occurrenceLabel: string;
  changes: BranchSummary;
  base: string | null;
}

/** `owner/repo` of a github.com URL (https, ssh or git@), lower-cased; null for anything else. */
export function githubRepoOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The PR link the report may carry: the run's URL when it is a PR of the project's own repository. */
export function reportablePrUrl(prUrl: string | null, repoUrl: string | null): string | null {
  if (!prUrl) return null;
  const repo = githubRepoOf(repoUrl);
  const pr = githubRepoOf(prUrl);
  if (!repo || !pr || pr !== repo) return null;
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(prUrl)) return null;
  return prUrl;
}

/** The summary the report may quote: the run's words unless they look like they hold a secret. */
export function reportableSummary(summary: string | null): string | null {
  if (!summary) return null;
  const hits = findSecretsInText(summary);
  return hits.length ? `[summary withheld: it looked like it contained a ${hits.join(', ')}]` : summary;
}

const STATE_GLYPH: Record<string, string> = { done: '✅', blocked: '⛔', needs_input: '❓', failed: '❌' };

/** The Slack message for one finished run, mrkdwn. */
export function reportText(i: ReportInput): string {
  const glyph = STATE_GLYPH[i.run.state] ?? '•';
  const head = `${glyph} ⏱ *${slackEscape(i.projectName)}* run ${slackEscape(i.occurrenceLabel)} → *${i.run.state.replace('_', ' ')}*${i.run.reason ? ` (${slackEscape(i.run.reason)})` : ''}`;
  const lines = [head];
  const facts: string[] = [changesLabel(i.changes)];
  const pr = reportablePrUrl(i.run.prUrl, i.repoUrl);
  if (pr) facts.push(`<${pr}|PR>`);
  if (typeof i.run.costUsd === 'number') facts.push(`$${i.run.costUsd.toFixed(2)}`);
  lines.push(facts.join(' · '));
  const summary = reportableSummary(i.run.summary);
  if (summary) lines.push(`> ${slackEscape(summary).split('\n').join('\n> ')}`);
  if (i.base && i.run.workstream) {
    // The workspace deep link, as the briefing's Slack links use: it opens the
    // run whether or not the reader has the simple UI (/chat without
    // simple-ui-enabled redirects to / and drops ws).
    lines.push(`<${sessionLink(i.base, i.projectId, i.run.workstream)}|the run> · <${i.base}/automations/${encodeURIComponent(i.projectId)}|the automation>`);
  }
  return lines.join('\n');
}

/** Post the report to the project's channel. Best effort; returns whether it was posted. */
export async function postRunReport(channel: string | null, input: ReportInput): Promise<boolean> {
  const client = getSlackApp()?.client;
  if (!client || !channel) return false;
  try {
    await client.chat.postMessage({ channel, text: reportText({ ...input, base: input.base ?? webBase() }), unfurl_links: false, unfurl_media: false });
    return true;
  } catch (err) {
    console.warn(`[AUTOMATION] ${input.projectName}: Slack report failed: ${(err as Error).message}`);
    return false;
  }
}
