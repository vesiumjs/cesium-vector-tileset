import type { Buffer } from 'node:buffer';
import type { BrowserContext } from 'playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CityReplaySnapshot {
  readonly requestCount: number;
  readonly uniqueUrlCount: number;
  readonly requests: ReadonlyArray<{ readonly url: string; readonly count: number }>;
}

/** Freeze public resources across performance runs; replay keeps tile latency fixed. */
export async function routeCityReplay(context: BrowserContext, mode: 'capture' | 'replay', observeRequests = false) {
  const directory = path.resolve('node_modules/.cache/playwright/city-resources');
  await mkdir(directory, { recursive: true });
  const responses = new Map<string, Promise<{ body: Buffer; contentType: string }>>();
  const requestCounts = observeRequests ? new Map<string, number>() : undefined;
  await context.route('https://tiles.openfreemap.org/**', async (route) => {
    const url = route.request().url();
    if (requestCounts)
      requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1);
    let response = responses.get(url);
    if (!response) {
      response = (async () => {
        const key = createHash('sha256').update(url).digest('hex');
        const metadata = path.join(directory, `${key}.json`);
        const payload = path.join(directory, `${key}.bin`);
        try {
          const { contentType } = JSON.parse(await readFile(metadata, 'utf8')) as { contentType: string };
          return { body: await readFile(payload), contentType };
        }
        catch (error) {
          if (mode === 'replay')
            throw new Error(`Uncaptured city resource: ${url}`, { cause: error });
          const fetched = await route.fetch();
          if (!fetched.ok())
            throw new Error(`City resource returned ${fetched.status()}: ${url}`);
          const body = await fetched.body();
          const contentType = fetched.headers()['content-type'] ?? 'application/octet-stream';
          await writeFile(payload, body);
          await writeFile(metadata, JSON.stringify({ url, contentType }));
          return { body, contentType };
        }
      })();
      responses.set(url, response);
    }
    const { body, contentType } = await response;
    if (/\/\d+\/\d+\/\d+\.(?:pbf|png|webp)(?:\?|$)/.test(url))
      await new Promise(resolve => setTimeout(resolve, 80));
    await route.fulfill({ body, contentType, headers: { 'access-control-allow-origin': '*' } });
  });
  if (!requestCounts)
    return undefined;
  // Node-side snapshots observe intercepted browser requests, including
  // repeated URLs. They do not assert response completion or tile residency.
  // Supplying a prior cumulative snapshot returns requests since that point.
  return (previous?: CityReplaySnapshot): CityReplaySnapshot => {
    const previousCounts = new Map(previous?.requests.map(request => [request.url, request.count]));
    const requests = Array.from(responses.keys(), url => ({
      url,
      count: (requestCounts.get(url) ?? 0) - (previousCounts.get(url) ?? 0),
    })).filter(request => request.count > 0);
    return {
      requestCount: requests.reduce((total, request) => total + request.count, 0),
      uniqueUrlCount: requests.length,
      requests,
    };
  };
}
