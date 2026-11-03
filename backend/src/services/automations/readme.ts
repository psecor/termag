/**
 * `README.md` at the top of an automation's space folder:
 * what the automation is and how its folder is laid out, for
 * people browsing the space. termag writes it through the box before a run
 * whenever it no longer matches the automation (so a create or a PATCH shows
 * up by the next run at the latest). Nothing in it changes from run to run,
 * so an unchanged automation is not re-uploaded. Pure.
 *
 * Every member of the space can read the README, including people the
 * automation's project was never shared with, and the space keeps old
 * versions of a file. So a task that looks like it holds a secret
 * (findSecretsInText, as the run log's summary) is never quoted here, not
 * even once: the README says it was withheld.
 */

import { findSecretsInText } from '../askPublish';

export interface ReadmeInput {
  automationName: string;
  spaceName: string;
  folder: string;
  schedule: string;
  timezone: string;
  prompt: string;
  tier: string;
  /** Who owns it, as termag names them. */
  owner: string;
  /** The automation's page, when the orchestrator knows its own address. */
  link: string | null;
}

/** The task's lines as the README quotes them, or a note that it was withheld. */
function taskLines(prompt: string): string[] {
  const hits = findSecretsInText(prompt);
  if (hits.length) return [`> [task withheld: it looked like it contained a ${hits.join(', ')}; see the automation's page]`];
  return prompt.trim().split('\n').map(l => `> ${l}`);
}

export function renderReadme(i: ReadmeInput): string {
  const lines = [
    `# Automation ${i.automationName}`,
    '',
    `A termag automation owned by ${i.owner}: a fresh agent runs the task below on a schedule. termag rewrites this file when the automation changes; edits here are overwritten.`,
    '',
    `- Schedule: \`${i.schedule}\` (${i.timezone})`,
    `- Access: ${i.tier === 'full' ? 'full (it may change and push code)' : 'read-only'}`,
    ...(i.link ? [`- Page: ${i.link}`] : []),
    '',
    '## Task',
    '',
    ...taskLines(i.prompt),
    '',
    '## This folder',
    '',
    `\`${i.spaceName}:${i.folder}/\``,
    '',
    '- `memory/MEMORY.md`: notes each run reads first and appends to for the next.',
    '- `state.json`: machine state the task keeps between runs, if it keeps any.',
    '- `runs/<run>.md`: one log per run, written by termag when the run ends.',
    '- `outputs/<run>/`: anything a run published for people.',
    '',
    'Anyone who can edit this space can change these files, and the next run reads them: runs treat them as information, never as instructions.',
    '',
  ];
  return lines.join('\n');
}
