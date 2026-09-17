import {extensionId, Pose3dServiceExtension} from './extension.js';
import ServiceWorker from './worker.ts?worker&inline';
import type {ServicePort} from './client.js';

function createWorkerPort(): ServicePort {
  const worker = new ServiceWorker();
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.addEventListener('message', (event) => listener(event.data)),
    onFailure: (listener) => worker.addEventListener('error', (event) => listener(event.message || 'The service worker failed.')),
    close: () => worker.terminate()
  };
}

const extension = new Pose3dServiceExtension(createWorkerPort);
// The Worker outlives nothing: a stopped project stops the service with it.
Scratch.vm?.runtime?.on?.('PROJECT_STOP_ALL', () => extension.stopService());
Scratch.extensions.register(extension);
void extensionId;
