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
  private eventTarget: EventTarget;
  private debugChunks: Blob[] = [];
  private generateFileOnStop: boolean;
  private mimeType: string;
  private previousPart: Blob | null = null;
  private testlifyStorageSignedUrl: string | undefined;
  private skipUploadToAPIVideo: boolean | undefined;
  private buffer: Uint8Array = new Uint8Array();
  private CHUNK_SIZE = 4 * 256 * 1024; // 1 MB
  private startByte = 0;


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
      if (this.previousPart) {
        const video = await this.streamUpload.uploadLastPart(this.previousPart);
        await this.uploadToTestlify(this.previousPart);
        if (this.onVideoAvailable) {
          this.onVideoAvailable(video);
        }
      } else if (this.onStopError) {
        const error: VideoUploadError = {
          raw: "No data available to upload",
          title: "No data available to upload",
        };
        this.onStopError(error);
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

  private async uploadToTestlify(videoChunk: Blob) {
    if (!this.testlifyStorageSignedUrl && this.skipUploadToAPIVideo === true) {
      throw new Error("Testlify storage url is required if upload to API Video is skipped");
    }

    const arrayBuffer = await videoChunk.arrayBuffer();
    const newChunk = new Uint8Array(arrayBuffer);
    const combinedBuffer = new Uint8Array(this.buffer.length + newChunk.length);
    combinedBuffer.set(this.buffer);
    combinedBuffer.set(newChunk, this.buffer.length);
    this.buffer = combinedBuffer;

    let totalSize: number = 0;

    if (this.buffer.length >= this.CHUNK_SIZE || this.buffer.length > 0) {
      const chunk: any = this.buffer.slice(0, Math.min(this.CHUNK_SIZE, this.buffer.length));
      const endByte = this.startByte + chunk.length;
      try {
        if (this.buffer.length < this.CHUNK_SIZE) {
          totalSize = endByte;
        }
        this.startByte = await this.streamUpload.uploadToTestlifyStorage(chunk, this.startByte, endByte, totalSize);
        this.buffer = this.buffer.slice(chunk.length);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private async onDataAvailable(ev: BlobEvent) {
    const isLast = (ev as any).currentTarget.state === "inactive";
    try {
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }
      if (this.previousPart) {
        const toUpload = new Blob([this.previousPart]);
        this.previousPart = ev.data;
        if (this.skipUploadToAPIVideo === false) {
          await this.streamUpload.uploadPart(toUpload);
        }
        await this.uploadToTestlify(toUpload);
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
      this.mediaRecorder.stop();
      this.onVideoAvailable = (v) => resolve(v);
      this.onStopError = (e) => reject(e);
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
