import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';

import {
  formatJson,
  readJson,
  repositoryRoot,
  type AppExtensionEntry,
  type AppExtensions,
  type EmbeddedExtensionEntry,
  type ExtensionManifest,
  type ProjectSource
} from './repository-config.ts';

const writeTracked = process.argv.includes('--write');
const declaration = await readJson<AppExtensions>('config/app-extensions.json');

if (declaration.schemaVersion !== 1) {
  throw new Error(`Unsupported app-extensions schemaVersion: ${declaration.schemaVersion}`);
}

const differences: string[] = [];

const integrity = (contents: Buffer): string =>
  `sha256-${createHash('sha256').update(contents).digest('base64')}`;

/** Resolves the directory an extension artifact is copied from, without touching the network. */
function packageDirectory(application: string, extension: AppExtensionEntry): URL {
  if (extension.provider === 'workspace') {
    if (extension.directory === undefined) {
      throw new Error(`${extension.id} is a workspace extension without a directory.`);
    }
    return new URL(`${extension.directory}/`, repositoryRoot);
  }
  if (extension.provider === 'npm') {
    return new URL(`apps/${application}/node_modules/${extension.package}/`, repositoryRoot);
  }
  throw new Error(`Unknown provider for ${extension.id}: ${String(extension.provider)}`);
}

/**
 * Reproduces one generated file.
 *
 * Extension bundles are ignored by Git because they are large and reproducible from the pinned
 * packages in `node_modules`, so they are always rewritten. Everything committed is only rewritten
 * with `--write`; otherwise a stale copy is reported, which is what keeps a review honest.
 */
async function materialize(target: URL, contents: Buffer | string, {tracked}: {tracked: boolean}) {
  const path = target.pathname.slice(repositoryRoot.pathname.length);
  const existing = await readFile(target).catch(() => null);
  if (existing !== null && existing.equals(Buffer.from(contents))) return;
  if (tracked && !writeTracked) {
    differences.push(existing === null ? `${path} is missing` : `${path} is out of date`);
    return;
  }
  await writeFile(target, contents);
}

for (const {app, bundle, extensions} of declaration.apps) {
  // The contract extension freezes its feature flags while it is evaluated, and a static bundle
  // evaluates its members in declaration order, so the app shell has to come first.
  if (extensions[0]?.provider !== 'workspace') {
    throw new Error(`${app} must declare its app shell as the first bundle member.`);
  }
  const sourceDirectory = new URL(`apps/${app}/source/`, repositoryRoot);
  const extensionsDirectory = new URL('extensions/', sourceDirectory);
  await mkdir(extensionsDirectory, {recursive: true});

  const entries: EmbeddedExtensionEntry[] = [];
  for (const extension of extensions) {
    const directory = packageDirectory(app, extension);
    const manifest = await readJson<{name: string; version: string}>(
      new URL('package.json', directory)
    );
    if (manifest.name !== extension.package) {
      throw new Error(`${extension.id} resolved to package ${manifest.name}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      throw new Error(`${extension.package} is not pinned to an exact version: ${manifest.version}`);
    }

    const javascript = await readFile(new URL(extension.artifact, directory));
    await materialize(new URL(`${extension.id}.js`, extensionsDirectory), javascript, {
      tracked: false
    });

    const entry: EmbeddedExtensionEntry = {
      id: extension.id,
      path: `extensions/${extension.id}.js`,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64'
    };

    if (extension.provider === 'npm') {
      entry.source = {
        provider: 'npm',
        package: extension.package,
        version: manifest.version,
        artifact: extension.artifact,
        integrity: integrity(javascript)
      };
      if (extension.apiManifest !== undefined) {
        const apiManifest = await readFile(new URL(extension.apiManifest, directory));
        const parsed = JSON.parse(apiManifest.toString('utf8')) as ExtensionManifest;
        if (parsed.id !== extension.id) {
          throw new Error(`${extension.package} publishes extension ID ${parsed.id}`);
        }
        await materialize(
          new URL(`${extension.id}.manifest.json`, extensionsDirectory),
          apiManifest,
          {tracked: true}
        );
        entry.source.apiManifest = {
          artifact: extension.apiManifest,
          path: `extensions/${extension.id}.manifest.json`,
          formatVersion: parsed.formatVersion,
          integrity: integrity(apiManifest)
        };
      }
    }

    entries.push(entry);
  }

  const memberIds = entries.map(({id}) => id);
  await materialize(
    new URL('embedded-extensions.json', sourceDirectory),
    formatJson({
      formatVersion: 1,
      extensions: entries,
      extensionBundles: [{...bundle, members: memberIds}]
    }),
    {tracked: true}
  );

  const projectUrl = new URL('project.source.json', sourceDirectory);
  const project = await readJson<ProjectSource>(projectUrl);
  project.extensions = memberIds;
  project.extensionURLs = Object.fromEntries(
    entries.map(({id, path}) => [id, `embedded-extension:${path}`])
  );
  await materialize(projectUrl, formatJson(project), {tracked: true});
}

if (differences.length > 0) {
  console.error(differences.map((difference) => `- ${difference}`).join('\n'));
  console.error('Run `pnpm run pin:extensions` after building packages/app-shell.');
  process.exitCode = 1;
} else {
  console.log(
    writeTracked
      ? `Pinned embedded extensions for ${declaration.apps.length} applications.`
      : 'Reproduced embedded extensions; committed files match config/app-extensions.json.'
  );
}
