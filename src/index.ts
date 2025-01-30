import {
  ProgressiveUploader,
  ProgressiveUploaderOptionsWithAccessToken,
  ProgressiveUploaderOptionsWithUploadToken,
  VideoUploadResponse,
} from "@fiddle-tools/video-uploader";
import { VideoUploadError } from "@fiddle-tools/video-uploader/dist/src/abstract-uploader";

export {
  ProgressiveUploaderOptionsWithAccessToken,
  ProgressiveUploaderOptionsWithUploadToken,
  VideoUploadResponse,
} from "@fiddle-tools/video-uploader";
export { VideoUploadError } from "@fiddle-tools/video-uploader/dist/src/abstract-uploader";

export interface Options {
  onError?: (error: VideoUploadError) => void;
  generateFileOnStop?: boolean;
  mimeType?: string;
  testlifyStorageSignedUrl: string | undefined;
  skipUploadToAPIVideo: boolean | undefined;
}

let PACKAGE_VERSION = "";
try {
  // @ts-ignore
  PACKAGE_VERSION = __PACKAGE_VERSION__ || "";
} catch (e) {
  // ignore
}

type EventType = "error" | "recordingStopped" | "videoPlayable";

export class ApiVideoMediaRecorder {
  private mediaRecorder: MediaRecorder;
  private streamUpload: ProgressiveUploader;
  private testlifyUploader: ProgressiveUploader | null;
  private onVideoAvailable?: (video: VideoUploadResponse) => void;
  private onStopError?: (error: VideoUploadError) => void;
  private onCustomUploadStopError?: (error: VideoUploadError) => void;
  private eventTarget: EventTarget;
  private debugChunks: Blob[] = [];
  private generateFileOnStop: boolean;
  private mimeType: string;
  private previousPart: Blob | null = null;
  private testlifyStorageSignedUrl: string | undefined;
  private skipUploadToAPIVideo: boolean | undefined;
  private buffer: Uint8Array = new Uint8Array();
  private uploadQueue: { chunk: Uint8Array; isFinal: boolean }[] = [];
  private isProcessingQueue = false;
  private startByte = 0;
  private isRecording = false;
  private MIN_CHUNK_SIZE = 16 * 256 * 1024;
  constructor(
    mediaStream: MediaStream,
    options: Options &
      (
        | ProgressiveUploaderOptionsWithUploadToken
        | ProgressiveUploaderOptionsWithAccessToken
      ),
    testlifyStorageSignedUrl: string | null = null,
  ) {
    this.eventTarget = new EventTarget();
    this.generateFileOnStop = options.generateFileOnStop || false;
    this.testlifyStorageSignedUrl = options.testlifyStorageSignedUrl;
    this.skipUploadToAPIVideo = options.skipUploadToAPIVideo;

    const findBestMimeType = () => {
      const supportedTypes = ApiVideoMediaRecorder.getSupportedMimeTypes();
      if (supportedTypes.length === 0) {
        throw new Error("No compatible supported video mime type");
      }
      return supportedTypes[0];
    };

    this.mimeType = options.mimeType || findBestMimeType();

    this.mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: this.mimeType,
    });

    this.mediaRecorder.addEventListener("stop", () => {
      const stopEventPayload = this.generateFileOnStop
        ? { file: new Blob(this.debugChunks, { type: this.mimeType }) }
        : {};
      this.dispatch("recordingStopped", stopEventPayload);
    });

    this.streamUpload = new ProgressiveUploader({
      preventEmptyParts: true,
      ...options,
      origin: {
        sdk: {
          name: "media-recorder",
          version: PACKAGE_VERSION,
        },
        ...options.origin,
      },
    });

    if (testlifyStorageSignedUrl) {
      this.testlifyUploader = new ProgressiveUploader({
        ...options,
        testlifyStorageSignedUrl: `${testlifyStorageSignedUrl}`,
      })
    } else {
      this.testlifyUploader = null;
    }

    this.mediaRecorder.ondataavailable = (e) => this.onDataAvailable(e);

    this.mediaRecorder.onstop = async () => {
      if (this.skipUploadToAPIVideo) {
        this.isRecording = false;
        if (this.buffer.length > 0) {
          this.uploadQueue.push({ chunk: this.buffer, isFinal: true });
          this.buffer = new Uint8Array(0);
          this.processUploadQueue();
        }
      }
      if (this.previousPart) {
        if (!this.skipUploadToAPIVideo) {
          const video = await this.streamUpload.uploadLastPart(this.previousPart);
          if (this.onVideoAvailable) {
            this.onVideoAvailable(video);
          }
        }
      } else if (!this.skipUploadToAPIVideo && this.onStopError) {
        const error: VideoUploadError = {
          raw: "No data available to upload (api.video error)",
          title: "No data available to upload",
        };
        this.onStopError(error);
      } else if (this.onCustomUploadStopError) {
        const error: VideoUploadError = {
          raw: "No data available to upload",
          title: "No data available to upload",
        };
        this.onCustomUploadStopError(error);
      }
    };
    (window as any).mediaRecorder = this.mediaRecorder;
  }

  public addEventListener(
    type: EventType,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions | undefined
  ): void {
    if (type === "videoPlayable") {
      this.streamUpload.onPlayable((video) =>
        this.dispatch("videoPlayable", video)
      );
    }
    this.eventTarget.addEventListener(type, callback, options);
  }

  private mergeBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  private async processUploadQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.uploadQueue.length > 0) {
      const { chunk, isFinal } = this.uploadQueue[0];
      try {
        await this.uploadChunk(chunk, isFinal);
        this.uploadQueue.shift();
      } catch (error) {
        console.error('Failed to upload chunk after retries:', error);
        this.isProcessingQueue = false;
        this.dispatch("error", error);
        return;
      }
    }

    this.isProcessingQueue = false;
  }

  private async uploadChunk(chunk: Uint8Array, isFinal: boolean): Promise<void> {
    if (!this.testlifyStorageSignedUrl) {
      throw new Error("Testlify storage URL is required");
    }

    const chunkBlob = new Blob([chunk], { type: this.mimeType });
    const start = this.startByte;
    const end = start + chunk.length - 1;
    const totalSize = isFinal ? (start + chunk.length) : '*';

    const headers = {
      'Content-Length': chunk.length.toString(),
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    };

    let attempts = 0;
    const maxRetries = 10;
    const backoffFactor = 500;

    while (attempts <= maxRetries) {
      try {
        const response = await fetch(this.testlifyStorageSignedUrl, {
          method: 'PUT',
          headers,
          body: chunkBlob,
        });

        if (response.ok) {
          console.log(`Chunk uploaded successfully: bytes ${start}-${end}`);
          this.startByte += chunk.length;

          if (isFinal) {
            const videoUploadResponse: VideoUploadResponse = await response.json();
            if (this.onVideoAvailable) {
              this.onVideoAvailable(videoUploadResponse);
            }
          }
          return;
        } else if (response.status === 308) {
          const rangeHeader = response.headers.get('Range');
          if (rangeHeader) {
            const uploadedUpTo = parseInt(rangeHeader.split('-')[1], 10);
            this.startByte = uploadedUpTo + 1;
          }
          console.log(`Chunk accepted for upload (status 308): bytes ${start}-${end}`);
          return;
        } else {
          const errorMsg = await response.text();
          throw new Error(`Upload failed: ${response.status} - ${errorMsg}`);
        }
      } catch (error) {
        attempts++;
        if (attempts > maxRetries) {
          throw new Error(`Upload failed after ${maxRetries} retries: ${error}`);
        }
        await new Promise(resolve => setTimeout(resolve, backoffFactor * Math.pow(2, attempts - 1)));
      }
    }
  }

  private async onDataAvailable(ev: BlobEvent) {
    const isLast = (ev as any).currentTarget.state === "inactive";
    try {
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }

      if (this.skipUploadToAPIVideo) {
        const arrayBuffer = await ev.data.arrayBuffer();
        const newChunk = new Uint8Array(arrayBuffer);
        this.buffer = this.mergeBuffers(this.buffer, newChunk);

        if (this.isRecording) {
          while (this.buffer.length >= this.MIN_CHUNK_SIZE) {
            const maxChunkSize = 2 * this.MIN_CHUNK_SIZE
            const availableChunkSize = Math.min(
              maxChunkSize,
              this.buffer.length - (this.buffer.length % (this.MIN_CHUNK_SIZE))
            );

            if (availableChunkSize === 0) break;

            const chunk = this.buffer.slice(0, availableChunkSize);
            this.buffer = this.buffer.slice(availableChunkSize);
            this.uploadQueue.push({ chunk, isFinal: false });
          }
        }

        this.processUploadQueue();
      }

      if (this.previousPart) {
        const toUpload = new Blob([this.previousPart]);
        this.previousPart = ev.data;
        if (!this.skipUploadToAPIVideo) {
          await this.streamUpload.uploadPart(toUpload);
        }
      } else {
        this.previousPart = ev.data;
      }
    } catch (error) {
      if (!isLast) this.mediaRecorder.stop();
      this.dispatch("error", error);
      if (this.onStopError) this.onStopError(error as VideoUploadError);
    }
  }

  private dispatch(type: EventType, data: any): boolean {
    return this.eventTarget.dispatchEvent(
      Object.assign(new Event(type), { data })
    );
  }

  public start(options?: { timeslice?: number }) {
    if (this.getMediaRecorderState() === "recording") {
      throw new Error("MediaRecorder is already recording");
    }
    this.isRecording = true;
    this.mediaRecorder.start(options?.timeslice || 5000);
  }

  public getMediaRecorderState(): RecordingState {
    return this.mediaRecorder.state;
  }

  public stop(): Promise<VideoUploadResponse> {
    return new Promise((resolve, reject) => {
      if (this.getMediaRecorderState() === "inactive") {
        reject(new Error("MediaRecorder is already inactive"));
      }
      this.isRecording = false;
      this.mediaRecorder.stop();
      this.onVideoAvailable = (v) => resolve(v);
      if (!this.skipUploadToAPIVideo) {
        this.onStopError = (e) => reject(e)
      }
      this.onCustomUploadStopError = (e) => reject(e)
    });
  }

  public pause() {
    if (this.getMediaRecorderState() !== "recording") {
      throw new Error("MediaRecorder is not recording");
    }
    this.mediaRecorder.pause();
  }

  public static getSupportedMimeTypes() {
    const VIDEO_TYPES = ["mp4", "webm", "ogg", "x-matroska"];
    const VIDEO_CODECS = [
      "vp9,opus",
      "vp8,opus",
      "vp9",
      "vp9.0",
      "vp8",
      "vp8.0",
      "h264",
      "h.264",
      "avc1",
      "av1",
      "h265",
      "h.265",
    ];

    const supportedTypes: string[] = [];
    VIDEO_TYPES.forEach((videoType) => {
      const type = `video/${videoType}`;
      VIDEO_CODECS.forEach((codec) => {
        const variations = [
          `${type};codecs=${codec}`,
          `${type};codecs:${codec}`,
          `${type};codecs=${codec.toUpperCase()}`,
          `${type};codecs:${codec.toUpperCase()}`,
          `${type}`,
        ];
        for (const variation of variations) {
          if (MediaRecorder.isTypeSupported(variation)) {
            supportedTypes.push(variation);
            break;
          }
        }
      });
    });
    return supportedTypes;
  }
}