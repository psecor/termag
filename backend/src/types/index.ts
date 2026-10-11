import { Prisma, User } from '@prisma/client';

// Augment Passport's Express.User to be our Prisma User
declare global {
  namespace Express {
    interface User {
      id: string;
      googleId: string;
      googleEmail: string;
      unixUsername: string;
      displayName: string;
      defaultAgentProvider: string;
      claudeGatewayEnabled: boolean;
      dotfilesRepoUrl: string | null;
      theme: Prisma.JsonValue;
      slackUserId: string | null;
      discordUserId: string | null;
      createdAt: Date;
      role: string;
      adminSource: string | null;
      lastSeenAt: Date | null;
      /** First-run wizard finished or skipped; null = never. */
      onboardedAt: Date | null;
      /** The last "Claude Cloud N" handed to this owner. */
      claudeSessionSeq: number;
    }

    interface Request {
      // Set by requireAuthOrAgentToken from the bearer token's instance.
      // Undefined for cookie sessions and for loopback status writes.
      agentInstanceId?: string | null;
    }
  }
}

// Augment express-session with our user
declare module 'express-session' {
  interface SessionData {
    userId: string;
  }
}

export interface AgentStatus {
  status: 'working' | 'waiting' | 'idle' | 'not_running';
  updatedAt: Date;
  message?: string;
  source?: string;
  waitingReason?: 'approval' | 'user_input' | 'unknown' | null;
  activityScore?: number;
  tokenBurst?: number;
  activeTurn?: boolean;
  threadId?: string;
  /** Arbitrary metadata from tmux poller (e.g. cursor's model, context %, files edited) */
  pollerMeta?: Record<string, any>;
  /** Total input tokens in the active conversation (for context size warning) */
  contextTokens?: number;
  /** Rate limit message if the session has hit a usage cap (e.g. "resets 3:45pm") */
  rateLimited?: string | null;
  /**
   * The agent just reached a natural "shrink the context" point (opened or
   * merged a PR), reported by the PostToolUse hook. Cleared on dismiss, when
   * the context reading resets (/clear or /compact happened), or after a TTL.
   */
  milestone?: SessionMilestone | null;
  /**
   * A Devin review pane's live state, written by the review sweep
   * (services/reviewSweep.ts) onto the AGENT session's status and pushed
   * over /ws/status like `milestone`. Not persisted (session_statuses
   * carries no column); reconstructable from tmux, so a restart rediscovers
   * it. Docs/review-ring.md.
   */
  review?: SessionReview | null;
  /** Box that owns this entry. Null is the orchestrator (loopback writers). */
  instanceId?: string | null;
}

export interface SessionReview {
  /** Last state classifyReviewPane read off the review pane. */
  state: 'reviewing' | 'waiting' | 'done' | 'exited';
  /** The PR under review; null when even the launch echo could not recover it. */
  pr: number | null;
  /** The PR link, stripped for shared viewers by the push path. */
  url: string | null;
  /** When the state last changed (the probe that produced this state). */
  at: Date;
  /** When a probe last moved INTO done (null = never seen done). */
  doneAt: Date | null;
  /** When the viewer focused the review terminal while the review was done. */
  seenAt: Date | null;
}

export interface SessionMilestone {
  kind: 'pr_created' | 'pr_merged';
  url: string | null;
  at: Date;
  /** Context reading at (and refreshed while) the milestone is pending; see services/milestone.ts. */
  contextTokens: number | null;
}

// Keyed by statusKey(instanceId, session), not the tmux name alone.
export type StatusMap = Map<string, AgentStatus>;

// Chrome CDP tab shape
export interface ChromeTab {
  url: string;
  title: string;
  favIcon?: string;
  windowId?: number;
}

export interface ChromeWindow {
  windowId: number;
  tabs: ChromeTab[];
}
