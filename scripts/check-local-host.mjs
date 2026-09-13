import {readFile} from 'node:fs/promises';

const repositoryRoot = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('config/local-host.json', repositoryRoot), 'utf8'));
const applications = JSON.parse(
  await readFile(new URL('config/app-extensions.json', repositoryRoot), 'utf8')
);
const errors = [];

if (config.schemaVersion !== 1) {
  errors.push(`Unsupported local-host schemaVersion: ${config.schemaVersion}`);
}
if (config.bindHost !== '127.0.0.1' && config.bindHost !== '::1') {
  errors.push(`bindHost must stay on the loopback interface: ${config.bindHost}`);
}

const {minimum, maximum} = config.portRange ?? {};
if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum >= maximum) {
  errors.push('portRange must declare an integer minimum below its maximum.');
}

/**
 * Every application needs exactly one port, and no application may be missing one.
 *
 * A port is part of the origin, so an app that silently falls back to an ephemeral port would open
 * a different storage area and look like it had lost the venue's calibration. Requiring the two
 * declarations to agree means adding an application cannot skip this decision.
 */
const declaredApps = applications.apps.map(({app}) => app);
const configuredApps = Object.keys(config.apps ?? {});
for (const app of declaredApps) {
  if (!configuredApps.includes(app)) errors.push(`${app} has no loopback port.`);
}
for (const app of configuredApps) {
  if (!declaredApps.includes(app)) errors.push(`${app} has a loopback port but is not an application.`);
}

const ports = [];
for (const [app, entry] of Object.entries(config.apps ?? {})) {
  if (!Number.isSafeInteger(entry?.port)) {
    errors.push(`${app} port must be an integer.`);
    continue;
  }
  if (entry.port < minimum || entry.port > maximum) {
    errors.push(`${app} port ${entry.port} is outside ${minimum}-${maximum}.`);
  }
  if (typeof entry.title !== 'string' || entry.title.length === 0) {
    errors.push(`${app} must declare a non-empty host page title.`);
  }
  ports.push([app, entry.port]);
}

/** Two applications on one venue PC must not share an origin, or they would share stored data. */
for (const [app, port] of ports) {
  const other = ports.find(([candidate, candidatePort]) => candidate !== app && candidatePort === port);
  if (other !== undefined) errors.push(`${app} and ${other[0]} share port ${port}.`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Loopback host ports are valid (${ports.map(([app, port]) => `${app}:${port}`).join(', ')}).`
  );
}
