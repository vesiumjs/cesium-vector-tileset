/**
 * Safe wrapper for the performance resource timing API in web workers with graceful degradation
 * @internal
 */
export class RequestPerformance {
  private start: string;
  private end: string;
  private measure: string;

  constructor(url: string) {
    this.start = `${url}#start`;
    this.end = `${url}#end`;
    this.measure = url;

    performance.mark(this.start);
  }

  finish(): PerformanceEntryList {
    performance.mark(this.end);
    let resourceTimingData = performance.getEntriesByName(this.measure);

    // fallback if web worker implementation of perf.getEntriesByName returns empty
    if (resourceTimingData.length === 0) {
      performance.measure(this.measure, this.start, this.end);
      resourceTimingData = performance.getEntriesByName(this.measure);

      performance.clearMeasures(this.measure);
    }

    // The start/end marks are only consumed by the fallback measure above;
    // the resource-timing path never reads them. Leaving them in place would
    // accumulate two marks per request, so always clean them up.
    performance.clearMarks(this.start);
    performance.clearMarks(this.end);

    return resourceTimingData;
  }
}
