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
  /** Set to true to enable debug UI for the blob buffer. */
  debugBufferStatus?: boolean;
  /** Target chunk size (in bytes) when uploading in skipUploadToAPIVideo mode.
   * Must be a multiple of 256KB. For example: 1MB, 2MB, etc.
   */
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
  private uploadQueue: { chunk: Blob; isFinal: boolean }[] = [];
  private isProcessingQueue = false;
  private startByte = 0;
  private isRecording = false;

  // --- Blob buffering (used when skipUploadToAPIVideo is true) ---
  private blobBuffer: Blob[] = [];
  private blobBufferSize: number = 0;
  private readonly TARGET_CHUNK_SIZE: number; // must be a multiple of 256KB

  // --- Fields for the debug status div(s) ---
  private static instanceCounter = 0;
  // @ts-ignore
  private instanceId: number;
  private bufferStatusElement: HTMLDivElement | null = null;
  private debugBufferStatus: boolean;

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

    if (this.skipUploadToAPIVideo) {
      if (this.debugBufferStatus) {
        this.instanceId = ++ApiVideoMediaRecorder.instanceCounter;
        this.bufferStatusElement = document.createElement("div");
        this.bufferStatusElement.id = `apiVideoBufferStatus_${this.instanceId}`;
        this.bufferStatusElement.style.position = "fixed";
        this.bufferStatusElement.style.bottom = `${this.instanceId * 150}px`;
        this.bufferStatusElement.style.right = "0px";
        this.bufferStatusElement.style.backgroundColor = "rgba(0,0,0,0.7)";
        this.bufferStatusElement.style.color = "#fff";
        this.bufferStatusElement.style.padding = "10px";
        this.bufferStatusElement.style.fontSize = "12px";
        this.bufferStatusElement.style.zIndex = "10000";
        document.body.appendChild(this.bufferStatusElement);
        this.updateBufferStatus();
      }
    } else {
      this.instanceId = ++ApiVideoMediaRecorder.instanceCounter;
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

    if (testlifyStorageSignedUrl) {
      this.testlifyUploader = new ProgressiveUploader({
        ...options,
        testlifyStorageSignedUrl: `${testlifyStorageSignedUrl}`,
      });
    } else {
      this.testlifyUploader = null;
    }

    this.mediaRecorder.ondataavailable = (e) => this.onDataAvailable(e);

    this.mediaRecorder.onstop = async () => {
      // Allow a short delay for any pending ondataavailable events.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.skipUploadToAPIVideo) {
        if (this.blobBufferSize > 0) {
          // Flush any remaining data as the final chunk.
          const finalChunk = new Blob(this.blobBuffer, { type: this.mimeType });
          this.uploadQueue.push({ chunk: finalChunk, isFinal: true });
          this.blobBuffer = [];
          this.blobBufferSize = 0;
          this.updateBufferStatus();
          await this.processUploadQueue();
        } else {
          if (this.onCustomUploadStopError) {
            const error: VideoUploadError = {
              raw: "No data available to upload",
              title: "No data available to upload",
            };
            this.onCustomUploadStopError(error);
          }
        }
        return;
      }
      // Non-skip branch
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
      }
    };

    // Expose the media recorder for debugging if desired.
    (window as any).mediaRecorder = this.mediaRecorder;
  }

  /**
   * Extract exactly `chunkSize` bytes from the blob buffer.
   * This function loops over the buffered Blobs and, if needed, slices the first Blob
   * so that exactly `chunkSize` bytes are concatenated into a new Blob.
   */
  private extractChunk(chunkSize: number): Blob {
    const collected: Blob[] = [];
    let collectedSize = 0;

    while (collectedSize < chunkSize && this.blobBuffer.length > 0) {
      const currentBlob = this.blobBuffer[0];
      if (collectedSize + currentBlob.size <= chunkSize) {
        collected.push(currentBlob);
        collectedSize += currentBlob.size;
        this.blobBuffer.shift();
      } else {
        const needed = chunkSize - collectedSize;
        collected.push(currentBlob.slice(0, needed));
        // Replace the first blob with the remaining data.
        this.blobBuffer[0] = currentBlob.slice(needed);
        collectedSize += needed;
      }
    }
    this.blobBufferSize -= chunkSize;
    return new Blob(collected, { type: this.mimeType });
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
        console.error("Failed to upload chunk after retries:", error);
        this.isProcessingQueue = false;
        this.dispatch("error", error);
        return;
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Upload a given Blob chunk.
   */
  private async uploadChunk(chunk: Blob, isFinal: boolean): Promise<void> {
    if (!this.testlifyStorageSignedUrl) {
      throw new Error("Testlify storage URL is required");
    }

    const start = this.startByte;
    const end = Math.max(0, start + chunk.size - 1);
    const totalSize = isFinal ? start + chunk.size : "*";

    const headers = {
      "Content-Length": chunk.size.toString(),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
    };

    let attempts = 0;
    const maxRetries = 10;
    const backoffFactor = 500;

    while (attempts <= maxRetries) {
      try {
        const response = await fetch(this.testlifyStorageSignedUrl, {
          method: "PUT",
          headers,
          body: chunk,
        });

        if (response.ok) {
          console.log(`Chunk uploaded successfully: bytes ${start}-${end}`);
          this.startByte += chunk.size;

          if (isFinal) {
            const videoUploadResponse: VideoUploadResponse = await response.json();
            if (this.onVideoAvailable) {
              this.onVideoAvailable(videoUploadResponse);
            }
          }
          return;
        } else if (response.status === 308) {
          const rangeHeader = response.headers.get("Range");
          if (rangeHeader) {
            const uploadedUpTo = parseInt(rangeHeader.split("-")[1], 10);
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
        await new Promise((resolve) =>
          setTimeout(resolve, backoffFactor * Math.pow(2, attempts - 1))
        );
      }
    }
  }

  /**
   * Called on each dataavailable event.
   *
   * In skipUploadToAPIVideo mode we buffer the incoming Blob(s).
   *  When the accumulated size reaches the target chunk size, we extract
   * exactly that many bytes (using Blob.slice) and add the resulting Blob to the upload queue.
   * In the normal branch we use the previous Blob part.
   */
  private async onDataAvailable(ev: BlobEvent) {
    const isLast = (ev as any).currentTarget.state === "inactive";
    try {
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }

      if (this.skipUploadToAPIVideo && ev.data.size > 0) {
        // Buffer the Blob directly.
        this.blobBuffer.push(ev.data);
        this.blobBufferSize += ev.data.size;

        // While we have enough data accumulated, extract a chunk.
        while (this.blobBufferSize >= this.TARGET_CHUNK_SIZE) {
          const chunk = this.extractChunk(this.TARGET_CHUNK_SIZE);
          this.uploadQueue.push({ chunk, isFinal: false });
        }
        this.updateBufferStatus();
        await this.processUploadQueue();
      } else {
        // Normal branch (do not skip upload to API video).
        if (this.previousPart) {
          const toUpload = this.previousPart;
          this.previousPart = ev.data;
          if (!this.skipUploadToAPIVideo) {
            await this.streamUpload.uploadPart(toUpload);
          }
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

  /**
   * Updates the debug status div (if enabled) with information about the blob buffer.
   */
  private updateBufferStatus(): void {
    if (!this.bufferStatusElement) return;
    const html = `<strong>Buffer Status (Instance ${this.instanceId}):</strong><br/>
      Blobs in buffer: ${this.blobBuffer.length}<br/>
      Total buffered size: ${this.blobBufferSize/1024} KB<br/>`;
    this.bufferStatusElement.innerHTML = html;
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
        return;
      }
      this.onVideoAvailable = (v) => resolve(v);
      if (!this.skipUploadToAPIVideo) {
        this.onStopError = (e) => reject(e);
      }
      this.onCustomUploadStopError = (e) => reject(e);
      this.mediaRecorder.stop();
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
