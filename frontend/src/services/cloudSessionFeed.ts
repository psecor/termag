import { CloudSessionFeed } from '../utils/cloudSessionFeed';
import { claudeSessionsApi } from './api';

export const cloudSessionFeed = new CloudSessionFeed(() => claudeSessionsApi.list('active').then(r => r.sessions));
