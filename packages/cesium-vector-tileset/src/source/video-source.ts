import type { VideoSourceSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { Evented } from '../util/evented';
import type { WorkerDispatcher } from '../worker/dispatcher';
import { ValidationError } from '@maplibre/maplibre-gl-style-spec';
import { getVideo } from '../util/ajax';
import { ensureError } from '../util/errors';
import { ErrorEvent } from '../util/evented';

import { SourceDataEvent } from '../util/events';
import { ResourceType, transformRequest } from '../util/request';
import { ImageSource } from './image-source';

/**
 * Places video frames at four geographical corners, following VideoSourceSpecification.
 * Configure the source in StyleSpecification.sources and apply changes with CesiumVectorTileset.setStyle.
 * Playback requests frames while the video is unpaused; raster-fade-duration controls tile fading.
 *
 * @internal
 */
export class VideoSource extends ImageSource {
  declare options: VideoSourceSpecification;
  urls: string[];
  video?: HTMLVideoElement;

  /**
   * @internal
   */
  private _onPlayingHandler = () => {
    this.style?.triggerRepaint?.();
  };

  constructor(id: string, options: VideoSourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super(id, options, dispatcher, eventedParent);
    this.type = 'video';
    this.options = options;
    this.urls = options.urls.slice();
  }

  async load(): Promise<void> {
    this._loaded = false;
    const options = this.options;

    this.urls = [];
    for (const url of options.urls) {
      this.urls.push((await transformRequest(url, ResourceType.Source, this.style?.transformRequest)).url);
    }
    try {
      const video = await getVideo(this.urls);
      this._loaded = true;
      if (!video) {
        return;
      }
      this.video = video;
      this.video.loop = true;

      // Start repainting when video starts playing. hasTransition() will then return
      // true to trigger additional frames as long as the videos continues playing.
      this.video.addEventListener('playing', this._onPlayingHandler);

      this.video.play();

      this.finishLoading();
    }
    catch (err) {
      this.fire(new ErrorEvent(ensureError(err)));
    }
  }

  /**
   * Pauses the video.
   */
  pause(): void {
    if (this.video) {
      this.video.pause();
    }
  }

  /**
   * Plays the video.
   */
  play(): void {
    if (this.video) {
      this.video.play();
    }
  }

  /**
   * Sets playback to a timestamp, in seconds.
   */
  seek(seconds: number): void {
    if (this.video) {
      const seekableRange = this.video.seekable;
      if (seconds < seekableRange.start(0) || seconds > seekableRange.end(0)) {
        this.fire(new ErrorEvent(new ValidationError(`sources.${this.id}`, null, `Playback for this video can be set only between the ${seekableRange.start(0)} and ${seekableRange.end(0)}-second mark.`)));
      }
      else {
        this.video.currentTime = seconds;
      }
    }
  }

  /**
   * Returns the HTML `video` element.
   *
   * @returns The HTML `video` element.
   */
  getVideo(): HTMLVideoElement | undefined {
    return this.video;
  }

  onAdd(): void {
    this.load();
    if (this.video) {
      this.video.play();
      this.setCoordinates(this.coordinates);
    }
  }

  onRemove(): void {
    super.onRemove();
    if (this.video) {
      this.video.removeEventListener('playing', this._onPlayingHandler);
      this.video.pause();
    }
  }

  /**
   * Publishes video frames to source tiles once frame data is available.
   */
  prepare(): void {
    if (Object.keys(this.tiles).length === 0 || !this.video || this.video.readyState < 2) {
      return; // not enough data for current position
    }

    let newTilesLoaded = false;
    for (const w in this.tiles) {
      const tile = this.tiles[w];
      if (tile.state !== 'loaded') {
        tile.state = 'loaded';
        tile.textureData = this.video;
        newTilesLoaded = true;
      }
    }

    if (newTilesLoaded) {
      this.fire(new SourceDataEvent('data', { sourceDataType: 'idle', sourceId: this.id }));
    }
  }

  serialize(): VideoSourceSpecification {
    return {
      type: 'video',
      urls: this.urls,
      coordinates: this.coordinates,
    };
  }

  hasTransition(): boolean {
    return Boolean(this.video && !this.video.paused);
  }
}
