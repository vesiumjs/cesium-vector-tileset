import type { WorkerDispatcher } from '../worker/dispatcher';
import type { PluginState, RTLPluginStatus } from './rtl-text-plugin-status';
import { browser } from '../util/browser';
import { Event, Evented } from '../util/evented';
import { getGlobalDispatcher } from '../worker/dispatcher';
import { MessageType } from '../worker/messages';
import { RTLPluginLoadedEventName } from './rtl-text-plugin-status';

class RTLMainThreadPlugin extends Evented {
  status: RTLPluginStatus = 'unavailable';
  url: string = null;
  private readonly _workerSyncs = new WeakMap<WorkerDispatcher, Promise<void>>();

  /** Sync RTL plugin state by broadcasting a message to the worker */
  _syncState(statusToSend: RTLPluginStatus, dispatcher = getGlobalDispatcher()): Promise<PluginState[]> {
    this.status = statusToSend;
    if (!dispatcher) {
      return Promise.resolve([]);
    }
    return dispatcher.broadcast(MessageType.syncRTLPluginState, { pluginStatus: statusToSend, pluginURL: this.url })
      .catch((error: unknown) => {
        if (getGlobalDispatcher() === dispatcher) {
          this.status = 'error';
        }
        throw error;
      });
  }

  /** New worker pools must import an already-loaded plugin again. */
  syncStateWithWorkers(): Promise<void> {
    const dispatcher = getGlobalDispatcher();
    if (!dispatcher) {
      return Promise.resolve();
    }
    const existing = this._workerSyncs.get(dispatcher);
    if (existing) {
      return existing;
    }
    const sync = this.status === 'loaded' || this.status === 'loading'
      ? this._requestImport(dispatcher)
      : this._syncState(this.status, dispatcher).then(() => {});
    this._workerSyncs.set(dispatcher, sync);
    return sync;
  }

  /** This one is exposed to outside */
  getRTLTextPluginStatus(): RTLPluginStatus {
    return this.status;
  }

  clearRTLTextPlugin(): void {
    this.status = 'unavailable';
    this.url = null;
  }

  async setRTLTextPlugin(url: string, deferred: boolean = false): Promise<void> {
    if (this.url) {
      // error
      throw new Error('setRTLTextPlugin cannot be called multiple times.');
    }

    this.url = browser.resolveURL(url);
    if (!this.url) {
      throw new Error(`requested url ${url} is invalid`);
    }
    if (this.status === 'unavailable') {
      // from initial state:
      if (deferred) {
        this.status = 'deferred';
        // fire and forget: in this case it does not need wait for the broadcasting result
        // it is important to sync the deferred status once because
        // symbol_bucket will be checking it in worker
        void this._syncState(this.status).catch(() => {});
      }
      else {
        return this._requestImport();
      }
    }
    else if (this.status === 'requested') {
      return this._requestImport();
    }
  }

  /** Send a message to worker which will import the RTL plugin script */
  async _requestImport(dispatcher = getGlobalDispatcher()): Promise<void> {
    if (!dispatcher) {
      this.status = 'deferred';
      return;
    }
    // all errors/exceptions will be handled by _syncState
    await this._syncState('loading', dispatcher);
    if (getGlobalDispatcher() !== dispatcher) {
      return;
    }
    this.status = 'loaded';
    this.fire(new Event(RTLPluginLoadedEventName));
  }

  /** Start a lazy loading process of RTL plugin */
  lazyLoad(): void {
    if (this.status === 'unavailable') {
      this.status = 'requested';
    }
    else if (this.status === 'deferred') {
      void this._requestImport().catch(() => {});
    }
  }
}

let rtlMainThreadPlugin: RTLMainThreadPlugin = null;

export function rtlMainThreadPluginFactory(): RTLMainThreadPlugin {
  rtlMainThreadPlugin ||= new RTLMainThreadPlugin();
  return rtlMainThreadPlugin;
}
