const instanceBuffers = {};

self.onmessage = function (event) {
  const data = event.data;
  const { type, instanceId } = data;

  if (type === 'initialize') {
    // self.testlifyStorageSignedUrl = data.testlifyStorageSignedUrl;
    instanceBuffers[instanceId] = {
      blobBuffer: [],
      blobBufferSize: 0,
      startByte: 0,
      isProcessingQueue: false,
      sessionUrl: data.testlifyStorageSignedUrl
    };
  } else if (type === 'bufferChunk') {
    const { chunk, isLast } = data;
    bufferChunk(instanceId, chunk, isLast);
  }
};

const CHUNK_ALIGNMENT = 4 * 1024 * 1024;

function bufferChunk(instanceId, chunk, isLast) {
  const buffer = instanceBuffers[instanceId];
  if (!buffer) return;

  buffer.blobBuffer.push(chunk);
  buffer.blobBufferSize += chunk.size;

  while (!isLast && buffer.blobBufferSize >= CHUNK_ALIGNMENT) {
    const alignedSize = Math.floor(buffer.blobBufferSize / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
    const extractedChunk = extractChunk(instanceId, alignedSize);
    if (extractedChunk.size > 0) {
      uploadChunk(extractedChunk, false, buffer.startByte, instanceId, buffer.sessionUrl);
      buffer.startByte += extractedChunk.size;
    }
  }

  // Process final chunk with any remaining data
  if (isLast && buffer.blobBufferSize > 0) {
    const finalChunk = extractChunk(instanceId, buffer.blobBufferSize);
    uploadChunk(finalChunk, true, buffer.startByte, instanceId, buffer.sessionUrl);
    buffer.startByte += finalChunk.size;
    buffer.blobBuffer = [];
    buffer.blobBufferSize = 0;
  }
}

function extractChunk(instanceId, chunkSize) {
  const buffer = instanceBuffers[instanceId];
  let collected = [];
  let collectedSize = 0;

  while (collectedSize < chunkSize && buffer.blobBuffer.length > 0) {
    const currentBlob = buffer.blobBuffer[0];
    const remaining = chunkSize - collectedSize;
    const takeBytes = Math.min(currentBlob.size, remaining);

    if (takeBytes === currentBlob.size) {
      collected.push(currentBlob);
      buffer.blobBuffer.shift();
    } else {
      collected.push(currentBlob.slice(0, takeBytes));
      buffer.blobBuffer[0] = currentBlob.slice(takeBytes);
    }

    collectedSize += takeBytes;
    buffer.blobBufferSize -= takeBytes;
  }

  buffer.blobBuffer = buffer.blobBuffer.filter(blob => blob.size > 0);
  return new Blob(collected);
}

async function uploadChunk(chunk, isFinal, startByte, instanceId, sessionUrl) {
  const buffer = instanceBuffers[instanceId];
  const end = startByte + chunk.size - 1;
  const totalSize = isFinal ? (buffer.startByte + chunk.size).toString() : '*';
  const headers = {
    "Content-Length": chunk.size.toString(),
    "Content-Range": `bytes ${startByte}-${end}/${totalSize}`,
  };

  try {
    const response = await fetch(sessionUrl, {
      method: "PUT",
      headers,
      body: chunk,
    });

    if (response.ok) {
      postMessage({
        type: 'uploadSuccess',
        data: { 
          videoUploadResponse: await response.json(), 
          isFinal, 
          instanceId 
        }
      });
      buffer.startByte += chunk.size;
    } else if (response.status === 308) {
      const rangeHeader = response.headers.get("Range");
      if (rangeHeader) {
        const uploadedUpTo = parseInt(rangeHeader.split('-')[1], 10);
        buffer.startByte = uploadedUpTo + 1;
        postMessage({ 
          type: 'uploadSuccess', 
          data: { isFinal, startByte: buffer.startByte, instanceId } 
        });
      }
    } else {
      const errorMsg = await response.text();
      postMessage({ type: 'uploadError', data: { error: errorMsg, instanceId } });
    }
  } catch (error) {
    postMessage({ type: 'uploadError', data: { error: error.message, instanceId } });
  }
}
