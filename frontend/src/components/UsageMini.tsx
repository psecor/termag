import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { worktimeApi, WorktimeResponse } from '../services/api';
import { PROVIDERS } from '../providers/registry';
import { fmtDurationShort } from '../utils/format';
import { todayDates } from '../utils/dates';
import { HUMAN, mergeWtDays, activeWtProviders, THERMO_MAX_MS, THERMO_MID_MS } from '../utils/worktime';

const GRAD_MARKS = [1, 2, 3, 4, 5, 6, 7, 8]; // hours

/**
 * The two-tube working-time thermometer in the sidebar footer (agents | you,
 * today). Clicking it opens the dashboard page — the old expanded overlay lives
 * there now. Fill heights are % of THERMO_MAX_MS (8h); the % readouts divide by
 * THERMO_MID_MS (4h = "100%"). Two denominators on purpose.
 */
export function UsageMini() {
  const [worktime, setWorktime] = useState<WorktimeResponse | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Two days covers the local/UTC straddle around midnight.
    const load = () => { worktimeApi.get(2).then(setWorktime).catch(() => {}); };
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!worktime) return null;

  const agentProviders = activeWtProviders(worktime).filter(p => p.id !== HUMAN);
  const humanConfig = PROVIDERS[HUMAN];
  const todayWt = mergeWtDays(worktime, todayDates());
  const todayHumanMs = todayWt[HUMAN]?.totalMs || 0;
  const todayAgentMs = Object.entries(todayWt).filter(([k]) => k !== HUMAN).reduce((s, [, v]) => s + v.totalMs, 0);

  return (
    <div
      className="usage-thermo"
      role="link"
      tabIndex={0}
      title="Open dashboard"
      onClick={() => navigate('/dashboard')}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/dashboard'); } }}
    >
      <div className="usage-thermo-header">
        <span className="usage-thermo-pct">{todayAgentMs > 0 ? `${Math.round((todayAgentMs / THERMO_MID_MS) * 100)}%` : '--'}</span>
        <span className="usage-thermo-pct usage-thermo-pct-human">{todayHumanMs > 0 ? `${Math.round((todayHumanMs / THERMO_MID_MS) * 100)}%` : '--'}</span>
      </div>
      <div className="usage-thermo-tubes">
        <div className="usage-thermo-tube usage-thermo-tube-stacked">
          {agentProviders.map(p => {
            const ms = todayWt[p.id]?.totalMs || 0;
            if (ms <= 0) return null;
            return (
              <div
                key={p.id}
                className="usage-thermo-stack-seg"
                style={{ height: `${Math.min((ms / THERMO_MAX_MS) * 100, 100)}%`, background: p.color.base }}
                title={`${p.displayName}: ${fmtDurationShort(ms)}`}
              />
            );
          })}
        </div>
        <div className="usage-thermo-tube usage-thermo-tube-stacked">
          {todayHumanMs > 0 && (
            <div
              className="usage-thermo-stack-seg"
              style={{ height: `${Math.min((todayHumanMs / THERMO_MAX_MS) * 100, 100)}%`, background: humanConfig.color.base }}
              title={`You: ${fmtDurationShort(todayHumanMs)}`}
            />
          )}
        </div>
        <div className="usage-thermo-marks">
          {GRAD_MARKS.map(mark => (
            <div key={mark} className={`usage-thermo-mark ${mark === 4 ? 'usage-thermo-mark-100' : ''}`} style={{ bottom: `${(mark / 8) * 100}%` }}>
              <span>{mark}h</span>
            </div>
          ))}
        </div>
      </div>
      <div className="usage-thermo-footer">
        <span className="usage-thermo-cost">{todayAgentMs > 0 ? fmtDurationShort(todayAgentMs) : '--'}</span>
        <span className="usage-thermo-cost usage-thermo-cost-human">{todayHumanMs > 0 ? fmtDurationShort(todayHumanMs) : '--'}</span>
      </div>
    </div>
  );
}
