import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';

export type CoreEventStatus = 'connected' | 'reconnecting' | 'offline';

const CoreEventSchema = z.object({
  type: z.string(),
  payload: z.record(z.unknown()),
});

function connectionStatus(value: unknown): CoreEventStatus | undefined {
  if (value === 'online' || value === 'connected') return 'connected';
  if (value === 'reconnecting') return 'reconnecting';
  if (value === 'offline') return 'offline';
  return undefined;
}

export function connectCoreEvents(
  queryClient: QueryClient,
  onStatus: (status: CoreEventStatus) => void = () => undefined,
): () => void {
  if (typeof EventSource === 'undefined') {
    onStatus('offline');
    return () => undefined;
  }

  onStatus('reconnecting');
  const source = new EventSource('/admin/core/events', { withCredentials: true });
  source.onopen = () => onStatus('connected');
  source.onerror = () => onStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
  source.onmessage = (event) => {
    let value: z.infer<typeof CoreEventSchema>;
    try {
      value = CoreEventSchema.parse(JSON.parse(event.data));
    } catch {
      return;
    }

    if (value.type === 'core_connection') {
      const nextStatus = connectionStatus(value.payload.status);
      if (nextStatus) onStatus(nextStatus);
    }
    void queryClient.invalidateQueries({ queryKey: ['core', 'sessions'] });
    if (typeof value.payload.session_id === 'string') {
      void queryClient.invalidateQueries({ queryKey: ['core', 'session', value.payload.session_id] });
    }
  };
  return () => source.close();
}
