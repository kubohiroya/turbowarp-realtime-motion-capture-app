import {readFile} from 'node:fs/promises';

export const repositoryRoot = new URL('../', import.meta.url);

/**
 * Shapes of the JSON this repository owns.
 *
 * The files are validated by the checks that read them, so these types describe the contract the
 * checks enforce rather than adding a second validation layer. Anything read from outside the
 * repository — a published extension manifest, an installed package — is typed the same way and
 * checked where it is used.
 */
export interface AppExtensionEntry {
  readonly id: string;
  readonly provider: 'npm' | 'workspace';
  readonly package: string;
  readonly directory?: string;
  readonly artifact: string;
  readonly apiManifest?: string;
}

export interface AppExtensionsEntry {
  readonly app: string;
  readonly bundle: {readonly id: string; readonly name: string};
  readonly extensions: readonly AppExtensionEntry[];
}

export interface AppExtensions {
  readonly schemaVersion: number;
  readonly documentation?: string;
  readonly apps: readonly AppExtensionsEntry[];
}

export interface EmbeddedApiManifest {
  artifact: string;
  path: string;
  formatVersion: number;
  integrity: string;
}

export interface EmbeddedExtensionSource {
  provider: 'npm';
  package: string;
  version: string;
  artifact: string;
  integrity: string;
  apiManifest?: EmbeddedApiManifest;
}

export interface EmbeddedExtensionEntry {
  id: string;
  path: string;
  mediaType: string;
  parameters: readonly unknown[];
  encoding: string;
  source?: EmbeddedExtensionSource;
}

export interface EmbeddedExtensions {
  formatVersion: number;
  extensions: EmbeddedExtensionEntry[];
  extensionBundles: Array<{id: string; name: string; members: string[]}>;
}

export interface ExtensionManifestArgument {
  readonly id: string;
  readonly type: string;
  readonly menu?: string;
}

export interface ExtensionManifestBlock {
  readonly opcode: string;
  readonly blockType: string;
  readonly arguments: readonly ExtensionManifestArgument[];
}

export interface ExtensionManifest {
  readonly formatVersion: number;
  readonly id: string;
  readonly blocks: readonly ExtensionManifestBlock[];
  readonly menus: ReadonlyArray<{readonly id: string; readonly acceptReporters: boolean}>;
}

export interface RequiredOperation {
  readonly capability: string;
  readonly opcode: string;
  readonly availability?: string;
}

export interface ExtensionRequirement {
  readonly role: string;
  readonly repository: string;
  readonly package: string;
  readonly extensionId: string;
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly status: string;
  readonly requiredOperations: readonly RequiredOperation[];
  readonly gaps: readonly string[];
}

export interface ExtensionRequirements {
  readonly schemaVersion: number;
  readonly reviewedOn: string;
  readonly epic: string;
  readonly issue: string;
  readonly documentation?: string;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ExtensionRequirement[];
  readonly readinessGates: Readonly<Record<string, readonly string[]>>;
}

export interface BlockContract {
  readonly blockType: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface ReadinessExtension {
  readonly role: string;
  readonly repository: string;
  readonly package: string;
  readonly version: string | null;
  readonly extensionId: string;
  readonly artifact: string | null;
  readonly manifest: string | null;
  readonly sha256: string | null;
  readonly status: string;
  readonly embeddedIn: readonly string[];
  readonly requiredOperations: readonly Required<RequiredOperation>[];
  readonly blockContracts: Readonly<Record<string, BlockContract>>;
  readonly gaps: readonly string[];
}

export interface ReadinessInventory {
  readonly schemaVersion: number;
  readonly generatedFrom?: string;
  readonly extensions: readonly ReadinessExtension[];
  readonly readinessGates: Readonly<Record<string, readonly string[]>>;
  readonly localImplementationCandidates?: ReadonlyArray<{
    readonly repository: string;
    readonly commit: string;
    readonly published: boolean;
  }>;
}

export interface ProjectSource {
  extensions: string[];
  extensionURLs: Record<string, string>;
  [key: string]: unknown;
}

/** Reads one JSON file relative to the repository root, or from an absolute URL. */
export async function readJson<T>(location: URL | string): Promise<T> {
  const url = typeof location === 'string' ? new URL(location, repositoryRoot) : location;
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
