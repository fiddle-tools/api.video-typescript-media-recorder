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
  /** Set to true to enable debug UI for the circular buffer. */
  debugBufferStatus?: boolean;
  /** The minimum size of each chunk to upload. */
  minChunkSize?: number;
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
  private uploadQueue: { chunk: Uint8Array; isFinal: boolean }[] = [];
  private isProcessingQueue = false;
  private startByte = 0;
  private isRecording = false;
  private MIN_CHUNK_SIZE = 4 * 1024 * 1024; // for example

  // === Fields for the circular buffer (used only when skipUploadToAPIVideo is true) ===
  // We use two pointers: readIndex and writeIndex.
  private allocatedBuffer: Uint8Array | null = null;
  private readIndex: number = 0;
  private writeIndex: number = 0;
  private readonly INITIAL_BUFFER_CAPACITY = 20 * 1024 * 1024; // 20 MB

  // === Fields for the debug status div(s) ===
  private static instanceCounter = 0;
  // @ts-ignore
  private instanceId: number;
  /** Will contain the numeric status element plus the progress bar, if debugBufferStatus is enabled */
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
    this.debugBufferStatus = options.debugBufferStatus || true;
    this.MIN_CHUNK_SIZE = options.minChunkSize || this.MIN_CHUNK_SIZE;
    // Initialize the circular buffer only if skipUploadToAPIVideo is true.
    if (this.skipUploadToAPIVideo) {
      this.allocatedBuffer = new Uint8Array(this.INITIAL_BUFFER_CAPACITY);
      this.readIndex = 0;
      this.writeIndex = 0;
      // Create a unique debug status div only if debugBufferStatus is enabled.
      if (this.debugBufferStatus) {
        this.instanceId = ++ApiVideoMediaRecorder.instanceCounter;
        this.bufferStatusElement = document.createElement("div");
        this.bufferStatusElement.id = `apiVideoBufferStatus_${this.instanceId}`;
        // Position it fixed (offset each instance a bit so they don't overlap)
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
      // When not using the circular buffer, assign a dummy instance id.
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      // --- Modified branch for skipUploadToAPIVideo ---
      if (this.skipUploadToAPIVideo) {
        if (this.allocatedBuffer) {
          const capacity = this.allocatedBuffer.length;
          const usedSize =
            this.writeIndex >= this.readIndex
              ? this.writeIndex - this.readIndex
              : capacity - this.readIndex + this.writeIndex;
          if (usedSize > 0) {
            // Flush any remaining data as the final chunk.
            let finalChunk: Uint8Array;
            if (this.readIndex + usedSize <= capacity) {
              finalChunk = this.allocatedBuffer
                .subarray(this.readIndex, this.readIndex + usedSize)
                .slice();
            } else {
              const firstPartLength = capacity - this.readIndex;
              const secondPartLength = usedSize - firstPartLength;
              finalChunk = new Uint8Array(usedSize);
              finalChunk.set(
                this.allocatedBuffer.subarray(this.readIndex, capacity),
                0
              );
              finalChunk.set(
                this.allocatedBuffer.subarray(0, secondPartLength),
                firstPartLength
              );
            }
            this.uploadQueue.push({ chunk: finalChunk, isFinal: true });
            // Mark the buffer as empty.
            this.readIndex = this.writeIndex;
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
        }
        return;
      }
      // --- End modified branch ---

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

    (window as any).mediaRecorder = this.mediaRecorder;
  }

  // public addEventListener(
  //   type: EventType,
  //   callback: EventListenerOrEventListenerObject | null,
  //   options?: boolean | AddEventListenerOptions | undefined
  // ): void {
  //   if (type === "videoPlayable") {
  //     this.streamUpload.onPlayable((video) =>
  //       this.dispatch("videoPlayable", video)
  //     );
  //   }
  //   this.eventTarget.addEventListener(type, callback, options);
  // }

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
        console.error("Failed to upload chunk after retries:", error);
        this.isProcessingQueue = false;
        this.dispatch("error", error);
        return;
      }
    }

    this.isProcessingQueue = false;
  }

  private async uploadChunk(
    chunk: Uint8Array,
    isFinal: boolean
  ): Promise<void> {
    if (!this.testlifyStorageSignedUrl) {
      throw new Error("Testlify storage URL is required");
    }

    const chunkBlob = new Blob([chunk], { type: this.mimeType });
    const start = this.startByte;
    const end = Math.max(0, start + chunk.length - 1);
    const totalSize = isFinal ? start + chunk.length : "*";

    const headers = {
      "Content-Length": chunk.length.toString(),
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
          body: chunkBlob,
        });

        if (response.ok) {
          console.log(`Chunk uploaded successfully: bytes ${start}-${end}`);
          this.startByte += chunk.length;

          if (isFinal) {
            const videoUploadResponse: VideoUploadResponse =
              await response.json();
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
          console.log(
            `Chunk accepted for upload (status 308): bytes ${start}-${end}`
          );
          return;
        } else {
          const errorMsg = await response.text();
          throw new Error(`Upload failed: ${response.status} - ${errorMsg}`);
        }
      } catch (error) {
        attempts++;
        if (attempts > maxRetries) {
          throw new Error(
            `Upload failed after ${maxRetries} retries: ${error}`
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, backoffFactor * Math.pow(2, attempts - 1))
        );
      }
    }
  }

  private async onDataAvailable(ev: BlobEvent) {
    const isLast = (ev as any).currentTarget.state === "inactive";
    try {
      if (this.generateFileOnStop) {
        this.debugChunks.push(ev.data);
      }

      if (this.skipUploadToAPIVideo && ev.data.size > 0) {
        // === Modified branch: Use a circular buffer with rotation pointers ===
        const newData = new Uint8Array(await ev.data.arrayBuffer());
        const newDataLength = newData.length;

        if (!this.allocatedBuffer) {
          this.allocatedBuffer = new Uint8Array(this.INITIAL_BUFFER_CAPACITY);
          this.readIndex = 0;
          this.writeIndex = 0;
        }

        let capacity = this.allocatedBuffer.length;
        let usedSize =
          this.writeIndex >= this.readIndex
            ? this.writeIndex - this.readIndex
            : capacity - this.readIndex + this.writeIndex;
        let freeSpace = capacity - usedSize;

        // If there isn’t enough free space, double the buffer’s capacity.
        if (newDataLength > freeSpace) {
          const newCapacity = capacity * 2;
          const newBuffer = new Uint8Array(newCapacity);
          // Copy the existing data contiguously into newBuffer.
          if (this.writeIndex >= this.readIndex) {
            newBuffer.set(
              this.allocatedBuffer.subarray(this.readIndex, this.writeIndex),
              0
            );
          } else {
            const tailLength = capacity - this.readIndex;
            newBuffer.set(
              this.allocatedBuffer.subarray(this.readIndex, capacity),
              0
            );
            newBuffer.set(
              this.allocatedBuffer.subarray(0, this.writeIndex),
              tailLength
            );
          }
          this.allocatedBuffer = newBuffer;
          this.readIndex = 0;
          this.writeIndex = usedSize;
          capacity = newCapacity;
          freeSpace = capacity - usedSize;
          this.updateBufferStatus();
        }

        // Append new data into the circular buffer.
        if (this.writeIndex + newDataLength <= capacity) {
          this.allocatedBuffer.set(newData, this.writeIndex);
          this.writeIndex = (this.writeIndex + newDataLength) % capacity;
        } else {
          const firstPartLength = capacity - this.writeIndex;
          this.allocatedBuffer.set(
            newData.subarray(0, firstPartLength),
            this.writeIndex
          );
          const secondPartLength = newDataLength - firstPartLength;
          this.allocatedBuffer.set(newData.subarray(firstPartLength), 0);
          this.writeIndex = secondPartLength;
        }

        // Update usedSize after appending.
        usedSize =
          this.writeIndex >= this.readIndex
            ? this.writeIndex - this.readIndex
            : capacity - this.readIndex + this.writeIndex;

        // Process complete chunks from the circular buffer.
        while (usedSize >= this.MIN_CHUNK_SIZE) {
          const fullChunkSize = usedSize - (usedSize % this.MIN_CHUNK_SIZE);
          const maxChunkSize = 2 * this.MIN_CHUNK_SIZE;
          const chunkSize = Math.min(maxChunkSize, fullChunkSize);
          let chunk: Uint8Array;
          if (this.readIndex + chunkSize <= capacity) {
            // The data is contiguous.
            chunk = this.allocatedBuffer
              .subarray(this.readIndex, this.readIndex + chunkSize)
              .slice();
          } else {
            // The data wraps around; create a temporary contiguous chunk.
            const firstPartLength = capacity - this.readIndex;
            const secondPartLength = chunkSize - firstPartLength;
            chunk = new Uint8Array(chunkSize);
            chunk.set(
              this.allocatedBuffer.subarray(this.readIndex, capacity),
              0
            );
            chunk.set(
              this.allocatedBuffer.subarray(0, secondPartLength),
              firstPartLength
            );
          }
          this.uploadQueue.push({ chunk, isFinal: false });
          this.readIndex = (this.readIndex + chunkSize) % capacity;
          usedSize -= chunkSize;
        }
        this.updateBufferStatus();
        await this.processUploadQueue();
        // === End modified branch ===
      } else {
        // Existing behavior when skipUploadToAPIVideo is false.
        if (this.previousPart) {
          const toUpload = new Blob([this.previousPart]);
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
   * Updates the debug status div (if enabled) with numeric info and a simple progress bar.
   */
  private updateBufferStatus(): void {
    if (!this.allocatedBuffer || !this.bufferStatusElement) return;
    const capacity = this.allocatedBuffer.length;
    const usedSize =
      this.writeIndex >= this.readIndex
        ? this.writeIndex - this.readIndex
        : capacity - this.readIndex + this.writeIndex;
    const freeSpace = capacity - usedSize;

    // Build numeric info.
    let html = `<strong>Buffer Status (Instance ${this.instanceId}):</strong><br/>
      Capacity: ${capacity} bytes<br/>
      Used: ${usedSize} bytes<br/>
      Free: ${freeSpace} bytes<br/>
      Read: ${this.readIndex}<br/>
      Write: ${this.writeIndex}<br/>`;

    // Build a progress bar.
    const barLength = 50;
    const progressArray = new Array(barLength).fill("░");
    const usedCells = Math.round((usedSize / capacity) * barLength);
    for (let i = 0; i < usedCells; i++) {
      progressArray[i] = "█";
    }
    // Compute approximate positions for the read and write pointers.
    const readPos = Math.floor((this.readIndex / capacity) * barLength);
    const writePos = Math.floor((this.writeIndex / capacity) * barLength);
    if (readPos === writePos) {
      progressArray[readPos] = "X";
    } else {
      progressArray[readPos] = "R";
      progressArray[writePos] = "W";
    }
    const progressBar = progressArray.join("");
    html += `<div style="font-family: monospace; white-space: pre;">${progressBar}</div>`;
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
