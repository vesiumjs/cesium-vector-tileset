let nextMeasurementId = 0;

/**
 * Safe wrapper for the performance resource timing API in web workers with graceful degradation
 * @internal
 */
export class RequestPerformance {
  private readonly url: string;

  private readonly startTime: number;

  private readonly measurementName: string;

  constructor(url: string) {
    this.url = url;
    this.startTime = performance.now();
    this.measurementName = `request-performance:${++nextMeasurementId}`;
  }

  finish(): PerformanceEntryList {
    const endTime = performance.now();
    const resourceTimingData = performance.getEntriesByName(this.url, 'resource');
    if (resourceTimingData.length)
      return resourceTimingData;

    // Numeric timestamps survive another request completing or being canceled.
    // Each fallback owns its measure; unfinished requests create no timeline entries.
    const measurement = performance.measure(this.measurementName, { start: this.startTime, end: endTime });
    performance.clearMeasures(this.measurementName);
    Object.defineProperty(measurement, 'name', { value: this.url });
    return [measurement];
  }
}
