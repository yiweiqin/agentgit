/**
 * Public surface of the AgenticGit daemon.
 *
 * This file exists so importing the package has no effect. `./main.ts` starts a server
 * when it loads — that is what an entry point is for — and the CLI reaches the daemon
 * through `import('@agentgit/daemon')` to get `serve` and `runDemo`. When the package
 * entry pointed at `main.ts`, `agentgit demo` finished its walkthrough and then printed
 * `AgenticGit board: http://localhost:7777`, because importing the demo had started the
 * daemon as a side effect. A package whose barrel file does something is a package that
 * does something every time it is mentioned.
 *
 * @module @agentgit/daemon
 */

export { serve, startBoard, fingerprintOf, assignIds } from './serve.ts'
export type { BoardServer, ServeOptions } from './serve.ts'

export {
  ENDPOINT_FILE_NAME,
  ENDPOINT_VERSION,
  endpointPathFor,
  isProcessAlive,
  readEndpoint,
  removeEndpoint,
  writeEndpoint,
} from './endpoint.ts'
export type { EndpointRecord } from './endpoint.ts'

export { createHubPublisher } from './hub.ts'
export type { HubPublisher, HubPublisherOptions } from './hub.ts'

/** The hub's read/write surface, re-exported so the CLI reaches it without a second import. */
export {
  computeHubVerdict,
  lastPublishedRuling,
  lastPublishedRulingId,
  publishHubVerdict,
  readHubVerdict,
  renderHubAdvisory,
  writeHubVerdict,
} from '@agentgit/core'
export type { HubPublishedRuling, HubRuling, HubVerdict } from '@agentgit/core'

export { runDemo } from './demo.ts'
export type { DemoOptions } from './demo.ts'
