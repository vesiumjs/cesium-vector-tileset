import type { BrowserContext } from 'playwright/test';

type GeometryWorkerStage = 'create' | 'combine' | 'prepare';
interface GeometryViews {
  attributes?: Record<string, { componentDatatype?: number; componentsPerAttribute?: number; values?: ArrayBufferView & { length?: number } } | undefined>;
  indices?: ArrayBufferView;
}
interface GeometryParameters {
  version?: string;
  requests?: GeometryParameters[];
  layout?: string;
  subTasks?: Array<{ geometry: GeometryViews | ArrayBufferView }>;
  createGeometryResults?: Array<{ packedData: ArrayBufferView }>;
  packedInstances?: Float64Array;
  geometries?: GeometryViews[];
  lineInputs?: Array<{ positions: Float64Array; vertices: Uint32Array; longitudes?: Float64Array }>;
  parameters?: { packedInstances?: Float64Array };
}
interface CombinedViews {
  geometries?: GeometryViews[];
  boundingSpheres?: ArrayBufferView;
  boundingSpheresCV?: ArrayBufferView;
}
interface GeometryResult extends CombinedViews {
  results?: Array<{ result: GeometryResult } | { error: { name: string; message: string; stack?: string } }>;
  packedData?: ArrayBufferView;
  combined?: CombinedViews;
  linePositions?: { values: Uint32Array };
  lineBoundsCV?: Float64Array;
}
interface BufferFootprint {
  viewBytes: number;
  viewCount: number;
  backingBytes: number;
  backingCount: number;
}
interface GeometryAttributeSummary {
  name: string;
  componentDatatype?: number;
  componentsPerAttribute?: number;
  viewCount: number;
  byteLength: number;
  length: number;
  unknownLengthViews: number;
}
interface CityWorkerTask {
  id: number;
  admissionId?: number;
  stage: GeometryWorkerStage;
  posted: number;
  received?: number;
  failed?: boolean;
  // One task is one Native message; requestCount counts owners inside a prepare batch.
  requestCount: number;
  resultCount?: number;
  failedRequestCount?: number;
  inputBytes: number;
  inputViewCount: number;
  backingBytes: number;
  backingCount: number;
  transferBytes: number;
  transferredBefore: number[];
  transferredAfter?: number[];
  resultBytes?: number;
  resultViewCount?: number;
  resultBackingBytes?: number;
  resultBackingCount?: number;
  instances?: number;
  geometryAttributes?: {
    layout?: string;
    layouts?: string[];
    input: GeometryAttributeSummary[];
    output?: GeometryAttributeSummary[];
  };
  input?: {
    geometry: BufferFootprint;
    lineTopology: BufferFootprint;
    metadata: BufferFootprint;
  };
  output?: {
    geometryCount: number;
    geometry: BufferFootprint;
    nativeSpheres: BufferFootprint;
    linePositions: BufferFootprint;
    lineBoundsCV: BufferFootprint;
  };
}
interface CityWorkerObservation {
  url: string;
  stage?: GeometryWorkerStage;
  tasks: CityWorkerTask[];
  terminated: number;
  payloadObserved?: false;
  geometryAttributes?: { diagnosticOnly: true; fairTiming: false; observerCpuMs: number };
}

/** Optional diagnosis only: observe real message delivery without changing its contents. */
export async function observeCityWorkers(context: BrowserContext, observeGeometryAttributes = false, observeTaskWakes = false, observePayload = true) {
  await context.addInitScript(({ observeGeometryAttributes, observeTaskWakes, observePayload }) => {
    // These helpers must live inside the init script, which is serialized into
    // the browser. Inspect only the explicit Native/owned preparation schema.
    const views = (values: Array<ArrayBufferView | undefined>): ArrayBufferView[] => values.filter(value => ArrayBuffer.isView(value));
    const geometryViews = (geometries: GeometryViews[] = []): ArrayBufferView[] => geometries.flatMap(geometry => views([
      ...Object.values(geometry.attributes ?? {}).map(attribute => attribute?.values),
      geometry.indices,
    ]));
    const footprint = (values: ArrayBufferView[]): BufferFootprint => {
      const owners = new Set(values.map(value => value.buffer));
      return {
        viewBytes: values.reduce((sum, value) => sum + value.byteLength, 0),
        viewCount: values.length,
        backingBytes: [...owners].reduce((sum, owner) => sum + owner.byteLength, 0),
        backingCount: owners.size,
      };
    };
    const transferLengths = (transfers: Transferable[]): number[] => transfers.map(value => value instanceof ArrayBuffer ? value.byteLength : 0);
    // Sums describe attribute views, including repeated/shared views. They
    // are neither deduplicated backing storage nor GPU allocation sizes.
    const attributeSummary = (geometries: GeometryViews[] = [], observation: CityWorkerObservation): GeometryAttributeSummary[] => {
      const started = performance.now();
      const summaries = new Map<string, GeometryAttributeSummary>();
      for (const geometry of geometries) {
        for (const [name, attribute] of Object.entries(geometry.attributes ?? {})) {
          const value = attribute?.values;
          if (!attribute || !value || !ArrayBuffer.isView(value))
            continue;
          const componentDatatype = typeof attribute.componentDatatype === 'number' ? attribute.componentDatatype : undefined;
          const componentsPerAttribute = typeof attribute.componentsPerAttribute === 'number' ? attribute.componentsPerAttribute : undefined;
          const key = JSON.stringify([name, componentDatatype, componentsPerAttribute]);
          let summary = summaries.get(key);
          if (!summary) {
            summary = { name, componentDatatype, componentsPerAttribute, viewCount: 0, byteLength: 0, length: 0, unknownLengthViews: 0 };
            summaries.set(key, summary);
          }
          summary.viewCount++;
          summary.byteLength += value.byteLength;
          if (typeof value.length === 'number')
            summary.length += value.length;
          else summary.unknownLengthViews++;
        }
      }
      const result = [...summaries.values()];
      observation.geometryAttributes!.observerCpuMs += performance.now() - started;
      return result;
    };
    const NativeWorker = window.Worker;
    window.cityWorkers = [];
    window.Worker = class extends NativeWorker {
      private readonly observation: CityWorkerObservation;

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const workerUrl = new URL(String(url), location.href);
        const stage = workerUrl.pathname.endsWith('/geometry-worker.mjs')
          || (workerUrl.pathname.endsWith('/geometry.worker.ts') && workerUrl.searchParams.has('worker_file'))
          ? 'prepare'
          : workerUrl.pathname.endsWith('/createGeometry.js')
            ? 'create'
            : workerUrl.pathname.endsWith('/combineGeometry.js') ? 'combine' : undefined;
        this.observation = { url: String(url), stage, tasks: [], terminated: 0 };
        if (!observePayload)
          this.observation.payloadObserved = false;
        if (observeGeometryAttributes)
          this.observation.geometryAttributes = { diagnosticOnly: true, fairTiming: false, observerCpuMs: 0 };
        window.cityWorkers.push(this.observation);
        if (observeTaskWakes)
          window.cityTaskWakeObserver?.register(this);
        this.addEventListener('message', (event) => {
          if (!observePayload)
            return;
          const task = this.observation.tasks.find(task => task.id === event.data?.id && task.received === undefined);
          if (!task)
            return;
          // Main-thread message round-trip includes Worker queue and delivery.
          // These timestamps do not measure Worker execution time.
          task.received = performance.now();
          task.failed = event.data.error != null;
          if (task.admissionId !== undefined)
            window.cityAdmissionObserver?.received(task.admissionId, task.received, task.failed);
          const result = event.data.result as GeometryResult | undefined;
          if (task.stage === 'create') {
            const output = footprint(views([result?.packedData]));
            task.resultBytes = output.viewBytes;
            task.resultViewCount = output.viewCount;
            task.resultBackingBytes = output.backingBytes;
            task.resultBackingCount = output.backingCount;
            return;
          }
          const entries = task.stage === 'prepare' ? result?.results : undefined;
          const prepared = entries
            ? entries.flatMap(entry => 'result' in entry ? [entry.result] : [])
            : result ? [result] : [];
          if (task.stage === 'prepare') {
            task.resultCount = entries?.length ?? (result ? 1 : 0);
            task.failedRequestCount = entries?.filter(entry => 'error' in entry).length ?? 0;
          }
          const combined = task.stage === 'prepare'
            ? prepared.flatMap(result => result.combined ? [result.combined] : [])
            : result ? [result] : [];
          const geometries = combined.flatMap(result => result.geometries ?? []);
          if (task.geometryAttributes)
            task.geometryAttributes.output = attributeSummary(geometries, this.observation);
          const geometry = geometryViews(geometries);
          const nativeSpheres = combined.flatMap(result => views([result.boundingSpheres, result.boundingSpheresCV]));
          const linePositions = task.stage === 'prepare' ? prepared.flatMap(result => views([result.linePositions?.values])) : [];
          const lineBoundsCV = task.stage === 'prepare' ? prepared.flatMap(result => views([result.lineBoundsCV])) : [];
          const output = footprint([...geometry, ...nativeSpheres, ...linePositions, ...lineBoundsCV]);
          task.resultBytes = output.viewBytes;
          task.resultViewCount = output.viewCount;
          task.resultBackingBytes = output.backingBytes;
          task.resultBackingCount = output.backingCount;
          task.output = {
            geometryCount: geometries.length,
            geometry: footprint(geometry),
            nativeSpheres: footprint(nativeSpheres),
            linePositions: footprint(linePositions),
            lineBoundsCV: footprint(lineBoundsCV),
          };
        });
      }

      postMessage(message: { id?: number; parameters?: GeometryParameters }, options?: Transferable[] | StructuredSerializeOptions) {
        const transfers = Array.isArray(options) ? options : options?.transfer ?? [];
        const parameters = message.parameters;
        let task: CityWorkerTask | undefined;
        if (observePayload && parameters && message.id !== undefined && (parameters.requests || parameters.geometries || parameters.subTasks || parameters.createGeometryResults)) {
          // Blob bootstrap URLs cannot identify the entry; their exact request
          // schema identifies the preparation stage without inspecting assets.
          const stage = parameters.requests || parameters.geometries ? 'prepare' : parameters.subTasks ? 'create' : 'combine';
          this.observation.stage = stage;
          const requests = stage === 'prepare' ? parameters.requests ?? [parameters] : [parameters];
          const geometries = stage === 'prepare' ? requests.flatMap(request => request.geometries ?? []) : undefined;
          const geometry = stage === 'prepare'
            ? geometryViews(geometries)
            : parameters.subTasks?.flatMap(({ geometry }) => ArrayBuffer.isView(geometry) ? [geometry] : geometryViews([geometry]))
              ?? views(parameters.createGeometryResults?.map(result => result.packedData) ?? []);
          const lineTopology = stage === 'prepare'
            ? requests.flatMap(request => (request.lineInputs ?? []).flatMap(input => views([input.positions, input.vertices, input.longitudes])))
            : [];
          const packedInstances = stage === 'prepare' ? requests.map(request => request.parameters?.packedInstances) : [parameters.packedInstances];
          const metadata = views(packedInstances);
          const input = footprint([...geometry, ...lineTopology, ...metadata]);
          const transferredBefore = transferLengths(transfers);
          let geometryAttributes: CityWorkerTask['geometryAttributes'];
          if (observeGeometryAttributes) {
            const inputGeometries = stage === 'prepare'
              ? geometries
              : parameters.subTasks?.flatMap(({ geometry }) => ArrayBuffer.isView(geometry) ? [] : [geometry]);
            const layouts = [...new Set(requests.flatMap(request => typeof request.layout === 'string' ? [request.layout] : []))];
            geometryAttributes = { layout: layouts.length === 1 ? layouts[0] : undefined, layouts, input: attributeSummary(inputGeometries, this.observation) };
          }
          task = {
            id: message.id,
            stage,
            requestCount: requests.length,
            posted: performance.now(),
            inputBytes: input.viewBytes,
            inputViewCount: input.viewCount,
            backingBytes: input.backingBytes,
            backingCount: input.backingCount,
            transferBytes: transferredBefore.reduce((sum, bytes) => sum + bytes, 0),
            transferredBefore,
            instances: stage === 'prepare'
              ? requests.reduce((sum, request) => sum + (request.geometries?.length ?? request.parameters?.packedInstances?.[0] ?? 0), 0)
              : parameters.subTasks?.length ?? parameters.packedInstances?.[0],
            // Group owner footprints may overlap (mesh + topology share a
            // packet owner); the top-level aggregate deduplicates all owners.
            input: { geometry: footprint(geometry), lineTopology: footprint(lineTopology), metadata: footprint(metadata) },
          };
          if (geometryAttributes)
            task.geometryAttributes = geometryAttributes;
          this.observation.tasks.push(task);
        }
        try {
          const admission = window.cityAdmissionObserver;
          const posted = admission ? performance.now() : undefined;
          const result = Array.isArray(options)
            ? super.postMessage(message, options)
            : super.postMessage(message, options);
          if (admission && task && parameters)
            task.admissionId = admission.posted(parameters, this, task.id, posted!);
          if (observeTaskWakes && message.id !== undefined && parameters) {
            const requests = parameters.requests ?? [parameters];
            const ownGeometry = this.observation.stage === 'prepare' && requests.length > 0 && requests.every(request =>
              typeof request.version === 'string' && Array.isArray(request.geometries)
              && ['native', 'line', 'surface-planar', 'surface-morph'].includes(request.layout ?? ''));
            window.cityTaskWakeObserver?.posted(this, message.id, ownGeometry, requests.length, task?.admissionId);
          }
          return result;
        }
        finally {
          if (task)
            task.transferredAfter = transferLengths(transfers);
        }
      }

      terminate() {
        this.observation.terminated++;
        const result = super.terminate();
        window.cityAdmissionObserver?.terminated(this);
        return result;
      }
    };
    if (observeTaskWakes) {
      // Native installs one function listener per message ID. A normal
      // observation listener cannot surround those later callbacks.
      const prototype = window.Worker.prototype;
      const add = NativeWorker.prototype.addEventListener;
      const remove = NativeWorker.prototype.removeEventListener;
      const listeners = new WeakMap<Worker, WeakMap<EventListener, Map<boolean, EventListener>>>();
      prototype.addEventListener = function (type, listener, options) {
        if (type !== 'message' || typeof listener !== 'function')
          return Reflect.apply(add, this, [type, listener, options]);
        const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
        let byListener = listeners.get(this);
        if (!byListener) {
          byListener = new WeakMap();
          listeners.set(this, byListener);
        }
        let byCapture = byListener.get(listener);
        if (!byCapture) {
          byCapture = new Map();
          byListener.set(listener, byCapture);
        }
        let wrapped = byCapture.get(capture);
        if (!wrapped) {
          wrapped = function (this: Worker, event: Event) {
            const observer = window.cityTaskWakeObserver;
            const operation = () => Reflect.apply(listener, this, [event]);
            return observer ? observer.withMessage(this, (event as MessageEvent).data?.id, operation) : operation();
          };
          byCapture.set(capture, wrapped);
        }
        return Reflect.apply(add, this, [type, wrapped, options]);
      };
      prototype.removeEventListener = function (type, listener, options) {
        const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
        const wrapped = type === 'message' && typeof listener === 'function'
          ? listeners.get(this)?.get(listener)?.get(capture)
          : undefined;
        return Reflect.apply(remove, this, [type, wrapped ?? listener, options]);
      };
    }
  }, { observeGeometryAttributes, observeTaskWakes, observePayload });
}

declare global {
  interface Window { cityWorkers: CityWorkerObservation[] }
}
