import { User } from '@prisma/client';

// Augment Passport's Express.User to be our Prisma User
declare global {
  namespace Express {
    interface User {
      id: string;
      googleId: string;
      googleEmail: string;
      unixUsername: string;
      displayName: string;
      createdAt: Date;
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
}

// Keyed by tmux session name: {username}-{project}-agent
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
