import type { WorkerChannel } from '../../packages/cesium-vector-tileset/src/worker/worker-channel';
import type { MvtWorkerObservation } from '../mvt-worker.spec';
import { Style } from '../../packages/cesium-vector-tileset/src/style/style';
import { MessageType } from '../../packages/cesium-vector-tileset/src/worker/messages';
import { getSharedWorkerPool, WorkerPool } from '../../packages/cesium-vector-tileset/src/worker/worker-pool';

WorkerPool.workerCount = 2;
const styles: Style[] = [];
const failures: Error[][] = [];
const calls: Array<{ status: 'pending' | 'resolved' | 'rejected'; error?: Error }> = [];
function createStyle() {
  const style = new Style();
  const errors: Error[] = [];
  style.on('error', event => errors.push(event.error));
  styles.push(style);
  failures.push(errors);
  return style;
}
function send(channel: WorkerChannel) {
  const call: (typeof calls)[number] = { status: 'pending' };
  calls.push(call);
  channel.sendAsync({ type: MessageType.setLayers, data: [] }).then(
    () => {
      call.status = 'resolved';
    },
    (error) => {
      call.status = 'rejected';
      call.error = error;
    },
  );
}
function failedChannel(style: Style) {
  return style.dispatcher.channels.find(channel => channel.target === window.mvtWorkers[0].worker);
}
const fixture = {
  async start() {
    const first = createStyle();
    const second = createStyle();
    await Promise.all(styles.map(style => style.dispatcher.waitForInitComplete()));
    send(failedChannel(first));
    send(failedChannel(second));
  },
  async lateClient() {
    const third = createStyle();
    await third.dispatcher.waitForInitComplete();
    send(failedChannel(third));
  },
  async healthy() {
    const channel = styles[1].dispatcher.channels.find(channel => channel.target === window.mvtWorkers[1].worker);
    await channel.sendAsync({ type: MessageType.updateGlobalState, data: { alive: true } });
    return true;
  },
  snapshot() {
    const cause = calls[0]?.error;
    return {
      calls: calls.map(call => ({ status: call.status, error: call.error?.message, name: call.error?.name })),
      sameCause:
        !!cause
        && calls.every(call => call.error === cause)
        && failures.every(errors => errors.length === 1 && errors[0] === cause),
      errors: failures.map(errors => errors.map(error => error.message)),
      pending: styles.map(style => Object.keys(failedChannel(style)?.pendingRequests ?? {}).length),
      workers: window.mvtWorkers.map(({ errors, messages, terminations }) => ({
        errors,
        messages,
        terminations,
      })),
      active: getSharedWorkerPool().numActive(),
    };
  },
  destroy() {
    styles.forEach(style => style.destroy());
  },
};

window.mvtWorkerFixture = fixture;
declare global {
  interface Window {
    mvtWorkers: MvtWorkerObservation[];
    mvtWorkerFixture: typeof fixture;
  }
}
