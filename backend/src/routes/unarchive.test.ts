import { describe, it, expect } from 'vitest';
import { planUnarchiveLaunches } from './unarchive';

describe('planUnarchiveLaunches', () => {
  it('creates an agent workflow when none exists and the caller asked for one', () => {
    expect(planUnarchiveLaunches({ existingWorkflows: [], initialAgentEnabled: true }))
      .toEqual({ createAgentWorkflow: true, relaunch: [] });
  });

  it('does nothing for an empty project when no initial agent was requested', () => {
    expect(planUnarchiveLaunches({ existingWorkflows: [], initialAgentEnabled: false }))
      .toEqual({ createAgentWorkflow: false, relaunch: [] });
  });

  it('relaunches an existing agent workflow instead of creating a second one', () => {
    // The 2026-09-18 bug: a project archived on one box and re-created on a
    // new one kept its agent workflow, so nothing created sessions on the
    // new box and the terminal showed tmux's "no sessions".
    const agent = { type: 'agent', provider: 'claude', workstream: 'main' };
    expect(planUnarchiveLaunches({ existingWorkflows: [agent], initialAgentEnabled: true }))
      .toEqual({ createAgentWorkflow: false, relaunch: [agent] });
  });

  it('relaunches existing workflows even when no initial agent was requested', () => {
    const agent = { type: 'agent', provider: 'codex', workstream: 'main' };
    expect(planUnarchiveLaunches({ existingWorkflows: [agent], initialAgentEnabled: false }))
      .toEqual({ createAgentWorkflow: false, relaunch: [agent] });
  });

  it('relaunches every workstream, agent workflows first, keeping data workflows', () => {
    const dataMain = { type: 'data', provider: null, workstream: 'main' };
    const agentMain = { type: 'agent', provider: 'claude', workstream: 'main' };
    const agentFeature = { type: 'agent', provider: 'claude', workstream: 'feature-x' };
    const plan = planUnarchiveLaunches({
      existingWorkflows: [dataMain, agentMain, agentFeature],
      initialAgentEnabled: true,
    });
    expect(plan.createAgentWorkflow).toBe(false);
    expect(plan.relaunch).toEqual([agentMain, agentFeature, dataMain]);
  });

  it('still creates an agent workflow when only data workflows exist', () => {
    const dataMain = { type: 'data', provider: null, workstream: 'main' };
    expect(planUnarchiveLaunches({ existingWorkflows: [dataMain], initialAgentEnabled: true }))
      .toEqual({ createAgentWorkflow: true, relaunch: [dataMain] });
  });
});
