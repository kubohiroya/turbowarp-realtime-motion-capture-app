import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openLoopbackPreviewBrowser} from '@kubohiroya/turbowarp-local-preview';

import {startLocalHost, type LocalHostFailure, type StartedLocalHost} from './host.ts';

export type CliLocale = 'en' | 'ja';

export interface LocalHostCliOptions {
  readonly app: string;
  readonly title: string;
  /** Baked at build time, because it decides which stored data this application reaches. */
  readonly port: number;
  /** The packaged player, embedded in the binary. */
  readonly player: string;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly onSignal?: (handler: () => void) => void;
}

export interface CliOutcome {
  readonly code: number;
  /** Present while the host is serving. `--preflight` stops before returning. */
  readonly host?: StartedLocalHost;
}

/**
 * Where run locks live.
 *
 * `XDG_RUNTIME_DIR` is per user by definition. The temp directory is the fallback, and it is shared
 * on some systems, so the venue name is not put in the path and the records hold nothing secret.
 */
export function resolveLockDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const runtime = env['XDG_RUNTIME_DIR'];
  return join(runtime !== undefined && runtime.length > 0 ? runtime : tmpdir(), 'multiview-pose');
}

export function resolveLocale(env: Readonly<Record<string, string | undefined>>): CliLocale {
  const language = env['LC_ALL'] ?? env['LC_MESSAGES'] ?? env['LANG'] ?? '';
  return /^ja(?:[._-]|$)/i.test(language) ? 'ja' : 'en';
}

function formatTime(isoDate: string, locale: CliLocale): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  return locale === 'ja' ? `${time}に起動` : `started ${time}`;
}

/**
 * Operator-facing failure text.
 *
 * Each message names what is wrong and what to do about it, and never attributes a port to one of
 * our applications without a run lock proving it.
 */
export function describeFailure(failure: LocalHostFailure, locale: CliLocale): string {
  if (locale === 'ja') {
    switch (failure.reason) {
      case 'already-running':
        return `このアプリは既に起動しています（pid ${failure.holder.pid}、${formatTime(failure.holder.startedAt, locale)}）。\n起動済みのウィンドウへ戻ってください: ${failure.holder.origin}`;
      case 'port-held-by-application':
        return `ポート ${failure.holder.port} は ${failure.holder.app} が使用中です（pid ${failure.holder.pid}）。\n2つのアプリに同じポートが割り当てられています。ビルド設定を直してください。`;
      case 'port-unavailable':
        return `ポート ${failure.port} を別のプログラムが使用中です。\nそのプログラムを終了してください。別のポートへは切り替えません。保存済みの校正と演出DSLはこのポートに紐づいているためです。`;
      case 'player-missing':
        return `アプリ本体を読み込めません: ${failure.path}`;
    }
  }
  switch (failure.reason) {
    case 'already-running':
      return `This application is already running (pid ${failure.holder.pid}, ${formatTime(failure.holder.startedAt, locale)}).\nReturn to the window that is already open: ${failure.holder.origin}`;
    case 'port-held-by-application':
      return `Port ${failure.holder.port} is held by ${failure.holder.app} (pid ${failure.holder.pid}).\nTwo applications are assigned the same port. Fix the build configuration.`;
    case 'port-unavailable':
      return `Port ${failure.port} is held by another program.\nStop that program. This app will not move to a different port, because the saved calibration and performance DSL belong to this one.`;
    case 'player-missing':
      return `The application could not be read: ${failure.path}`;
  }
}

/**
 * Runs the venue host.
 *
 * `--preflight` performs exactly the same startup and then stops without opening a browser, so a
 * check before the show answers the same questions the real start would.
 */
export async function runLocalHostCli(options: LocalHostCliOptions): Promise<CliOutcome> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => console.log(line));
  const writeError = options.writeError ?? ((line: string) => console.error(line));
  const locale = resolveLocale(env);
  const preflight = argv.includes('--preflight');
  /** For a PC where the operator already has the window open, and for scripted checks. */
  const openWindow = !argv.includes('--no-open');

  const result = await startLocalHost({
    app: options.app,
    title: options.title,
    port: options.port,
    lockDirectory: resolveLockDirectory(env),
    player: {html: options.player}
  });

  if (!result.started) {
    writeError(describeFailure(result, locale));
    return {code: 1};
  }

  const {host} = result;
  write(
    locale === 'ja'
      ? `${options.title} を ${host.origin} で起動しました。`
      : `${options.title} is serving at ${host.origin}.`
  );
  write(
    locale === 'ja'
      ? `保存済みの設定はこのアドレスに紐づきます。`
      : `Saved settings belong to this address.`
  );

  if (preflight) {
    await host.stop();
    write(locale === 'ja' ? '起動前チェックに合格しました。' : 'Preflight passed.');
    return {code: 0};
  }

  if (!openWindow) {
    write(host.url);
    return {code: 0, host: registerShutdown(host, options)};
  }

  const open = options.openBrowser ?? openLoopbackPreviewBrowser;
  await open(host.url).catch((error: unknown) => {
    writeError(
      locale === 'ja'
        ? `ブラウザを開けませんでした。次のアドレスを手で開いてください: ${host.url}`
        : `Could not open a browser. Open this address by hand: ${host.url}`
    );
    writeError(String(error));
  });

  return {code: 0, host: registerShutdown(host, options)};
}

function registerShutdown(host: StartedLocalHost, options: LocalHostCliOptions): StartedLocalHost {
  const onSignal = options.onSignal ?? defaultSignalHandler;
  onSignal(() => {
    void host.stop().then(() => process.exit(0));
  });
  return host;
}

function defaultSignalHandler(handler: () => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, handler);
}
