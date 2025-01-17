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
  private isRecording = false;

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
        if (!this.skipUploadToAPIVideo) {
          const video = await this.streamUpload.uploadLastPart(this.previousPart);
          if (this.onVideoAvailable) {
            this.onVideoAvailable(video);
          }
        }
      } else if (this.onStopError) {
        const error: VideoUploadError = {
          raw: "No data available to upload",
          title: "No data available to upload",
        };
        this.onStopError(error);
      }
      this.isRecording = false;
      // await this.uploadToTestlify();
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

  // private async uploadToTestlify() {
  //   if (!this.testlifyStorageSignedUrl && this.skipUploadToAPIVideo === true) {
  //     throw new Error("Testlify storage url is required if upload to API Video is skipped");
  //   }

  //   const totalSize: any = '*';
  //   while (this.buffer.length >= this.CHUNK_SIZE) {
  //     const chunk: any = this.buffer.slice(0, Math.min(this.CHUNK_SIZE, this.buffer.length));
  //     const endByte = this.startByte + chunk.length;
  //     try {
  //       this.startByte = await this.streamUpload.uploadToTestlifyStorage(chunk, this.startByte, endByte, totalSize);
  //       this.buffer = this.buffer.slice(chunk.length);
  //     } catch (error) {
  //       console.error(error);
  //       break;
  //     }
  //   }
  //   // last chunk when recording is stopped
  //   if (!this.isRecording && this.buffer.length > 0) {
  //     const endByte = this.startByte + this.buffer.length;
  //     try {
  //       const chunk: any = this.buffer.slice(0, this.buffer.length);
  //       this.startByte = await this.streamUpload.uploadToTestlifyStorage(chunk, this.startByte, endByte, endByte);
  //     } catch (error) {
  //       console.error(error);
  //     }
  //   }
  // }

  private async uploadChunk(chunk: Blob, startByte: number, endByte: number, totalSize: number | string): Promise<{ status: number, response: VideoUploadResponse | null }> {
    if (!this.testlifyStorageSignedUrl) {
      throw new Error("Testlify storage URL is required if upload to API Video is skipped");
    }

    const headers = {
      'Content-Length': chunk.size.toString(),
      'Content-Range': `bytes ${startByte}-${endByte - 1}/${totalSize}`,
    };

    try {
      const response = await fetch(this.testlifyStorageSignedUrl, {
        method: 'PUT',
        headers,
        body: chunk,
      });

      if (response.ok) {
        console.log(`Chunk uploaded successfully: bytes ${startByte}-${endByte - 1}`);
        const videoUploadResponse: VideoUploadResponse = await response.json();
        return { status: 200, response: videoUploadResponse };
      } else if (response.status === 308) {
        console.log(`Chunk accepted for upload (status 308): bytes ${startByte}-${endByte - 1}`);
        return { status: 308, response: null };
      } else {
        const errorMsg = await response.text();
        console.error(`Upload failed: ${response.status} - ${errorMsg}`);
        throw new Error(`Upload failed: ${response.status}`);
      }
    } catch (error) {
      console.error(`Upload failed with error: ${error}`);
      throw error;
    }
  }

  private async handleUploads() {
    let totalSize: number | string = '*';
    let lastSuccessfulUpload: VideoUploadResponse | null = null;

    while (this.isRecording || this.buffer.length > 0) {
      if (this.buffer.length >= this.CHUNK_SIZE || (!this.isRecording && this.buffer.length > 0)) {
        const chunk = this.buffer.slice(0, Math.min(this.CHUNK_SIZE, this.buffer.length));
        const endByte = this.startByte + chunk.length;

        try {
          if (this.buffer.length < this.CHUNK_SIZE && !this.isRecording) {
            totalSize = endByte;
          }
          const { status, response } = await this.uploadChunk(new Blob([chunk], { type: 'video/webm' }), this.startByte, endByte, totalSize);
          if (status === 200 && response) {
            lastSuccessfulUpload = response;
          }
          this.startByte = endByte;
          this.buffer = this.buffer.slice(chunk.length);

        } catch (error) {
          console.error(error);
          break;
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (lastSuccessfulUpload) {
      if (this.onVideoAvailable) {
        this.onVideoAvailable(lastSuccessfulUpload);
      }
      this.isRecording = false;
    } else {
      console.error('No valid video upload response found.');
      if (this.onStopError) {
        const error: VideoUploadError = {
          raw: "No video upload response was successful.",
          title: "Upload Error",
        };
        this.onStopError(error);
      }
    }
  }

  private async onDataAvailable(ev: BlobEvent) {
    const isLast = (ev as any).currentTarget.state === "inactive";
    try {
      if (this.skipUploadToAPIVideo) {
        if (ev.data.size > 0) {
          const arrayBuffer = await ev.data.arrayBuffer();
          const newChunk = new Uint8Array(arrayBuffer);
          const combinedBuffer = new Uint8Array(this.buffer.length + newChunk.length);
          combinedBuffer.set(this.buffer);
          combinedBuffer.set(newChunk, this.buffer.length);
          this.buffer = combinedBuffer;
          // await this.uploadToTestlify();
        }
      }
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }
      if (this.previousPart) {
        const toUpload = new Blob([this.previousPart]);
        this.previousPart = ev.data;
        if (this.skipUploadToAPIVideo === false) {
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
    if (this.skipUploadToAPIVideo) {
      this.handleUploads()
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
      this.isRecording = false;
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
