import {readJson, type AppExtensions, type LocalHostConfig} from './repository-config.ts';

/**
 * Checks only what a running host cannot check for itself.
 *
 * The host verifies its own port at startup and refuses to run when it is taken, so a missing,
 * out-of-range, or occupied port already fails loudly where it matters. What is left are the two
 * mistakes that *succeed*: a bind host off the loopback interface quietly exposes the venue LAN, and
 * two applications sharing a port works until the day someone runs both on one machine. Neither
 * produces an error for the host to report, so they have to be caught while the value is still being
 * reviewed.
 */
const config = await readJson<LocalHostConfig>('config/local-host.json');
const applications = await readJson<AppExtensions>('config/app-extensions.json');
const errors: string[] = [];

if (config.schemaVersion !== 1) {
  errors.push(`Unsupported local-host schemaVersion: ${config.schemaVersion}`);
}

if (config.bindHost !== '127.0.0.1' && config.bindHost !== '::1') {
  errors.push(
    `bindHost must stay on the loopback interface, or the host is reachable from the venue LAN: ${config.bindHost}`
  );
}

const ports = Object.entries(config.apps ?? {}).map(([app, entry]) => [app, entry?.port] as const);
for (const [app, port] of ports) {
  const other = ports.find(([candidate, candidatePort]) => candidate !== app && candidatePort === port);
  if (other !== undefined) {
    errors.push(
      `${app} and ${other[0]} share port ${String(port)}, so they cannot run on one venue PC.`
    );
  }
}

const declaredApps = applications.apps.map(({app}) => app);
for (const [app] of ports) {
  if (!declaredApps.includes(app)) {
    errors.push(`${app} has a loopback port but is not an application.`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Loopback host ports are distinct and bound to ${config.bindHost} (${ports
      .map(([app, port]) => `${app}:${String(port)}`)
      .join(', ')}).`
  );
}
