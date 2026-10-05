import type { WorkerEndpoint } from '../worker-channel';
import { describe, expect, it, vi } from 'vitest';
import { MessageType } from '../messages';
import { WorkerChannel } from '../worker-channel';

type WireMessage = Parameters<WorkerChannel['receive']>[0]['data'];

function channels() {
  class Endpoint extends EventTarget {
    peer!: Endpoint;

    postMessage(message: WireMessage): void {
      // Worker replies also enter the worker's queue. The fixture keeps
      // that ordering while avoiding unrelated network and tile parsing.
      this.peer.dispatchEvent(new MessageEvent('message', {
        data: { ...message, mustQueue: true },
      }));
    }
  }
  const clientEndpoint = new Endpoint();
  const workerEndpoint = new Endpoint();
  clientEndpoint.peer = workerEndpoint;
  workerEndpoint.peer = clientEndpoint;
  const client = new WorkerChannel(clientEndpoint as unknown as WorkerEndpoint, 'client');
  const worker = new WorkerChannel(workerEndpoint as unknown as WorkerEndpoint, 'worker');
  return { client, worker };
}

describe('worker message scheduling', () => {
  it('cancels a queued request before its handler runs and continues with the next request', async () => {
    const { client, worker } = channels();
    const handler = vi.fn(async (_id, request: { url: string }) => ({ data: request.url }));
    worker.registerMessageHandler(MessageType.getResource, handler);
    try {
      const controller = new AbortController();
      const canceled = client.sendAsync({ type: MessageType.getResource, data: { url: 'canceled' } }, controller);
      expect(handler).not.toHaveBeenCalled();
      controller.abort();
      await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
      const next = await client.sendAsync({ type: MessageType.getResource, data: { url: 'next' } });
      expect(next.data).toBe('next');
      expect(handler).toHaveBeenCalledTimes(1);
    }
    finally {
      client.remove();
      worker.remove();
    }
  });

  it('processes a response while an earlier asynchronous handler is waiting for it', async () => {
    const { client, worker } = channels();
    client.registerMessageHandler(MessageType.getResource, async (_id, request) => ({ data: request.url }));
    worker.registerMessageHandler(MessageType.getResource, async () => {
      const nested = await worker.sendAsync({ type: MessageType.getResource, data: { url: 'nested' } });
      return { data: `completed:${nested.data}` };
    });
    try {
      const response = await client.sendAsync({ type: MessageType.getResource, data: { url: 'outer' } });
      expect(response.data).toBe('completed:nested');
    }
    finally {
      client.remove();
      worker.remove();
    }
  });

  it('rejects pending requests and ignores scheduled work after a channel fails', async () => {
    const { client, worker } = channels();
    const handler = vi.fn(async () => ({ data: 'unreachable' }));
    worker.registerMessageHandler(MessageType.getResource, handler);
    try {
      const pending = client.sendAsync({ type: MessageType.getResource, data: { url: 'pending' } });
      const failure = new Error('worker failed');
      worker.fail(failure);
      client.fail(failure);
      await expect(pending).rejects.toBe(failure);
      worker.processNextMessage();
      expect(handler).not.toHaveBeenCalled();
      await expect(client.sendAsync({ type: MessageType.getResource, data: { url: 'later' } })).rejects.toBe(failure);
    }
    finally {
      client.remove();
      worker.remove();
    }
  });
});
