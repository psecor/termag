function isoNow() {
  return new Date().toISOString();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function mapCodexThreadStatus(statusObj) {
  if (!statusObj || typeof statusObj !== 'object') {
    return { status: 'idle', waitingReason: null, activeTurn: false, message: 'Missing Codex thread status' };
  }

  const type = statusObj.type;
  const flags = Array.isArray(statusObj.activeFlags) ? statusObj.activeFlags : [];

  if (type === 'active') {
    if (flags.includes('waitingOnApproval')) {
      return { status: 'waiting', waitingReason: 'approval', activeTurn: true, message: 'Approval required' };
    }
    if (flags.includes('waitingOnUserInput')) {
      return { status: 'waiting', waitingReason: 'user_input', activeTurn: true, message: 'User input required' };
    }
    return { status: 'working', waitingReason: null, activeTurn: true, message: 'Turn active' };
  }

  if (type === 'idle') {
    return { status: 'idle', waitingReason: null, activeTurn: false, message: 'Thread idle' };
  }

  if (type === 'systemError') {
    return { status: 'idle', waitingReason: null, activeTurn: false, message: 'Codex system error' };
  }

  return { status: 'idle', waitingReason: null, activeTurn: false, message: `Unhandled thread status: ${String(type)}` };
}

class CodexStatusTracker {
  constructor(session, options = {}) {
    this.session = session;
    this.threadId = null;
    this.turnId = null;
    this.updatedAt = options.now || isoNow();
    this.status = 'not_running';
    this.source = 'codex-app-server';
    this.waitingReason = null;
    this.message = 'Not running';
    this.activeTurn = false;
    this.tokenBurst = 0;
    this.lastTokenAt = null;
    this.lastAssistantAt = null;
    this.lastReasoningAt = null;
    this.lastTerminalAt = null;
    this.shortDecayMs = options.shortDecayMs || 3000;
  }

  snapshot(now = Date.now()) {
    return {
      session: this.session,
      status: this.status,
      updatedAt: this.updatedAt,
      message: this.message,
      source: this.source,
      waitingReason: this.waitingReason,
      activityScore: this.computeActivityScore(now),
      tokenBurst: this.tokenBurst || undefined,
      activeTurn: this.activeTurn,
      threadId: this.threadId || undefined,
    };
  }

  markReady(message = 'Codex ready') {
    this.status = 'idle';
    this.waitingReason = null;
    this.message = message;
    this.activeTurn = false;
    this.updatedAt = isoNow();
    this.tokenBurst = 0;
    return this.snapshot();
  }

  markNotRunning(message = 'Codex process not running') {
    this.status = 'not_running';
    this.waitingReason = null;
    this.message = message;
    this.activeTurn = false;
    this.updatedAt = isoNow();
    this.tokenBurst = 0;
    return this.snapshot();
  }

  ingestNotification(message, now = Date.now()) {
    if (!message || typeof message !== 'object') return this.snapshot(now);
    const { method, params } = message;

    if (method === 'thread/started') {
      this.threadId = params?.thread?.id || params?.threadId || this.threadId;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'turn/started') {
      this.turnId = params?.turn?.id || this.turnId;
      this.activeTurn = true;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'thread/status/changed') {
      this.threadId = params?.threadId || this.threadId;
      const mapped = mapCodexThreadStatus(params?.status);
      this.status = mapped.status;
      this.waitingReason = mapped.waitingReason;
      this.message = mapped.message;
      this.activeTurn = mapped.activeTurn;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'thread/tokenUsage/updated') {
      const last = params?.tokenUsage?.last;
      this.turnId = params?.turnId || this.turnId;
      this.tokenBurst = Number(last?.totalTokens || 0);
      this.lastTokenAt = now;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'item/agentMessage/delta' || method === 'agent/message/delta') {
      this.turnId = params?.turnId || this.turnId;
      this.lastAssistantAt = now;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'item/reasoningText/delta' || method === 'reasoning/text/delta') {
      this.turnId = params?.turnId || this.turnId;
      this.lastReasoningAt = now;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'item/terminalInteraction' || method === 'terminal/interaction') {
      this.turnId = params?.turnId || this.turnId;
      this.lastTerminalAt = now;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    if (method === 'turn/completed') {
      this.turnId = params?.turn?.id || this.turnId;
      this.activeTurn = false;
      if (this.status === 'working') {
        this.status = 'idle';
        this.message = 'Turn completed';
      }
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }
    return this.snapshot(now);
  }

  ingestServerRequest(message, now = Date.now()) {
    if (!message || typeof message !== 'object') return this.snapshot(now);
    const { method, params } = message;

    if (method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval'
      || method === 'item/permissions/requestApproval') {
      this.status = 'waiting';
      this.waitingReason = 'approval';
      this.message = 'Approval required';
      this.activeTurn = true;
      this.turnId = params?.turnId || this.turnId;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }

    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.status = 'waiting';
      this.waitingReason = 'user_input';
      this.message = 'User input required';
      this.activeTurn = true;
      this.turnId = params?.turnId || this.turnId;
      this.updatedAt = isoNow();
      return this.snapshot(now);
    }

    return this.snapshot(now);
  }

  computeActivityScore(now = Date.now()) {
    if (this.status === 'not_running' || this.status === 'idle') return 0;
    if (this.status === 'waiting') return 0.25;

    let score = 0.6;
    if ((this.lastAssistantAt != null && now - this.lastAssistantAt <= this.shortDecayMs)
      || (this.lastReasoningAt != null && now - this.lastReasoningAt <= this.shortDecayMs)) {
      score = Math.max(score, 0.8);
    }
    if (this.lastTokenAt != null && now - this.lastTokenAt <= this.shortDecayMs) {
      score = Math.max(score, 1.0);
    }
    if (this.lastTerminalAt != null && now - this.lastTerminalAt <= this.shortDecayMs) {
      score = Math.max(score, 0.8);
    }
    return clamp01(score);
  }
}

module.exports = {
  CodexStatusTracker,
};
