import { BoxFeed } from '../utils/boxFeed';
import { boxStatusBus } from '../utils/boxStatusBus';
import { instancesApi } from './api';

export const boxFeed = new BoxFeed(() => instancesApi.list(), boxStatusBus);
