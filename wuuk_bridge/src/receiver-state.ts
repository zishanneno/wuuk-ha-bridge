import { createHash } from 'node:crypto';
import type { PushReceiver } from '@eneris/push-receiver';

export interface ReceiverState {
  deviceId: string;
  accountId?: string;
  persistentIds: string[];
  credentials?: ConstructorParameters<typeof PushReceiver>[0]['credentials'];
}

export function receiverStateForAccount(state: ReceiverState, userId: string): ReceiverState {
  const accountId = createHash('sha256').update(String(userId)).digest('hex');
  if (state.accountId === accountId) return state;

  // Legacy state has no verified owner, so its registration must also be replaced.
  return { deviceId: state.deviceId, accountId, persistentIds: [] };
}
