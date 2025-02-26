import workerCode from '!!raw-loader!./upload-worker.js';
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
  debugBufferStatus?: boolean;
  targetChunkSize?: number;
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
  private uploadQueue: { chunk: Blob; isFinal: boolean }[] = [];
  private isProcessingQueue = false;
  private startByte = 0;
  private isRecording = false;
  private blobBuffer: Blob[] = [];
  private blobBufferSize: number = 0;
  private readonly TARGET_CHUNK_SIZE: number;
  private instanceId: string;
  // --- Worker  ---
  private worker: Worker | null = null;
  debugBufferStatus: boolean;
  private finalChunkSent = false;

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
    this.debugBufferStatus = options.debugBufferStatus ?? false;
    this.TARGET_CHUNK_SIZE = options.targetChunkSize || 1024 * 1024 * 4; // 4MB
    this.instanceId = this.getInstanceId();
    if (this.skipUploadToAPIVideo) {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
      this.worker.postMessage({
        type: "initialize",
        instanceId: this.instanceId,
        testlifyStorageSignedUrl: this.testlifyStorageSignedUrl,
        targetChunkSize: this.TARGET_CHUNK_SIZE,
      });

      this.worker.onmessage = this.handleWorkerMessage.bind(this);
    }

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
    this.mediaRecorder.ondataavailable = (e) => this.onDataAvailable(e);
    this.mediaRecorder.onstop = async () => {
      // await new Promise((resolve) => setTimeout(resolve, 200));
      if (this.skipUploadToAPIVideo) {
        // if (this.blobBufferSize > 0) {
        //   const finalChunk = new Blob(this.blobBuffer, { type: this.mimeType });
        //   this.uploadQueue.push({ chunk: finalChunk, isFinal: true });
        //   this.blobBuffer = [];
        //   this.blobBufferSize = 0;
        //   await this.processUploadQueue();
        // } else {
        //   if (this.onCustomUploadStopError) {
        //     const error: VideoUploadError = {
        //       raw: "No data available to upload",
        //       title: "No data available to upload",
        //     };
        //     this.onCustomUploadStopError(error);
        //   }
        // }
        return;
      }
      if (this.previousPart) {
        const video = await this.streamUpload.uploadLastPart(this.previousPart);
        if (this.onVideoAvailable) {
          this.onVideoAvailable(video);
        }
      }
    };

    (window as any).mediaRecorder = this.mediaRecorder;
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { type, data } = event.data;

    if (type === 'uploadSuccess') {
      const { videoUploadResponse, isFinal } = data;
      if (isFinal) {
        if (this.onVideoAvailable) {
          console.log("Calling onVideoAvailable with response", videoUploadResponse);
          this.onVideoAvailable(videoUploadResponse);
        } else {
          console.error("onVideoAvailable is not set correctly", videoUploadResponse);
        }
      }
    } else if (type === 'uploadError') {
      const { error } = data;
      if (this.onStopError) {
        this.onStopError(error);
      }
    }
  }

  private getInstanceId(): string {
    return `recorder-${Math.random().toString(36).substr(2, 9)}`;
  }

  private async onDataAvailable(ev: BlobEvent) {
    const isLast = this.getMediaRecorderState() === "inactive";
    if (isLast && this.finalChunkSent) {
      return;
    }
    try {
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }
      if (this.skipUploadToAPIVideo && ev.data.size > 0) {
        this.worker?.postMessage({
          type: "bufferChunk",
          instanceId: this.instanceId,
          chunk: ev.data,
          isLast,
        });
        if (isLast) {
          console.log("Last chunk sent");
          this.finalChunkSent = true;
        }
      } else {
        if (this.previousPart) {
          const toUpload = this.previousPart;
          this.previousPart = ev.data;
          await this.streamUpload.uploadPart(toUpload);
        } else {
          this.previousPart = ev.data;
        }
      }
    } catch (error) {
      if (!isLast) this.mediaRecorder.stop();
      this.dispatch("error", error);
      if (this.onStopError) this.onStopError(error as VideoUploadError);
    }
  }

  private async processUploadQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.uploadQueue.length > 0) {
      const { chunk, isFinal } = this.uploadQueue.shift()!;
      this.worker?.postMessage({
        type: 'uploadChunk',
        chunk,
        isFinal,
        startByte: this.startByte,
        mimeType: this.mimeType,
      });
      this.startByte += chunk.size;
    }

    this.isProcessingQueue = false;
  }

  public start(options?: { timeslice?: number }) {
    if (this.getMediaRecorderState() === "recording") {
      throw new Error("MediaRecorder is already recording");
    }
    this.isRecording = true;
    this.mediaRecorder.start(options?.timeslice || 5000);
  }

  public stop(): Promise<VideoUploadResponse> {
    return new Promise((resolve, reject) => {
      if (this.getMediaRecorderState() === "inactive") {
        reject(new Error("MediaRecorder is already inactive"));
        return;
      }
      this.mediaRecorder.stop();
      let callbackExecuted = false;
      this.onVideoAvailable = (v) => {
        if (!callbackExecuted) {
          callbackExecuted = true;
          resolve(v);
        }
      };
      if (!this.skipUploadToAPIVideo) {
        this.onStopError = (e) => reject(e);
      }
      this.onCustomUploadStopError = (e) => reject(e);
    });
  }

  public pause() {
    if (this.getMediaRecorderState() !== "recording") {
      throw new Error("MediaRecorder is not recording");
    }
    this.mediaRecorder.pause();
  }
  public getMediaRecorderState(): RecordingState {
    return this.mediaRecorder.state;
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

  private dispatch(type: EventType, data: any): boolean {
    return this.eventTarget.dispatchEvent(
      Object.assign(new Event(type), { data })
    );
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
