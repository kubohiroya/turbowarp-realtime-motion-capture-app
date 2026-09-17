import { Pose3dService } from './service.ts';

/**
 * The Worker side of interface v1. Everything it knows arrives as a message, so the same service
 * runs here, in tests, and in a replay tool without any of them depending on a browser page.
 */
const service = new Pose3dService();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const reply = service.handle(event.data);
  if (reply !== null) scope.postMessage(reply);
};
