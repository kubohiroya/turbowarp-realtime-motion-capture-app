import definitions from './block-definitions.json';
import {appFlagNames, validateAppConfig, type AppShellAppConfig} from './app-config.js';
import {featureFlagNames, type FeatureFlagApplication} from './feature-flags.js';
import type {LensCalibrationLauncher} from './lens-calibration.js';
import {askNumbersWithDialog, confirmWithDialog, type DialogHost} from './dialogs.js';
import {jsonValueOf, readJsonPath, withJsonField} from './json-fields.js';
import type {NetworkRouter} from './network-router.js';
import type {CameraGrid} from './camera-grid.js';
import type {PoseMeter} from './pose-meter.js';
import type {SettingsStore} from './settings.js';
import {parseButtonLabels, type QrPanel} from './qr-panel.js';
import type {MultiviewPoseShell} from './shell.js';

type BlockTypeName = 'COMMAND' | 'REPORTER' | 'BOOLEAN';
type ArgumentTypeName = 'STRING' | 'NUMBER' | 'BOOLEAN';

interface DefinitionArgument {
  type: ArgumentTypeName;
  defaultValue?: string | number | boolean;
  menu?: string;
}

interface BlockDefinition {
  opcode: string;
  blockType: BlockTypeName;
  text: string;
  description: string;
  arguments: Record<string, DefinitionArgument>;
  /** Present on blocks only an application with that capability offers. */
  requires?: 'lensCalibration' | 'cameraGrid';
}

const blockDefinitions = definitions.blocks as readonly BlockDefinition[];

/** Parses the details argument. Anything that is not a JSON object renders as no details at all. */
function toDetails(value: unknown): Record<string, unknown> {
  const text = Scratch.Cast.toString(value).trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class MultiviewPoseAppShellExtension implements TurboWarpExtension {
  private readonly config: AppShellAppConfig;
  private readonly shell: MultiviewPoseShell;
  private readonly flags: FeatureFlagApplication;
  private readonly lensCalibration: LensCalibrationLauncher | null;
  private readonly qrPanel: QrPanel | null;
  private readonly dialogs: DialogHost;
  private readonly network: NetworkRouter | null;
  private readonly cameraGrid: CameraGrid | null;
  private readonly poseMeter: PoseMeter | null;
  private readonly settings: SettingsStore | null;
  private confirmed = false;
  private numbers = '';

  public constructor(
    config: AppShellAppConfig,
    shell: MultiviewPoseShell,
    flags: FeatureFlagApplication,
    parts: {
      lensCalibration?: LensCalibrationLauncher;
      qrPanel?: QrPanel;
      dialogs?: DialogHost;
      network?: NetworkRouter;
      cameraGrid?: CameraGrid;
      poseMeter?: PoseMeter;
      settings?: SettingsStore;
    } = {}
  ) {
    this.config = validateAppConfig(config);
    this.shell = shell;
    this.flags = flags;
    this.lensCalibration = parts.lensCalibration ?? null;
    this.qrPanel = parts.qrPanel ?? null;
    this.dialogs = parts.dialogs ?? {document: null};
    this.network = parts.network ?? null;
    this.cameraGrid = parts.cameraGrid ?? null;
    this.poseMeter = parts.poseMeter ?? null;
    this.settings = parts.settings ?? null;
  }

  public getInfo(): Record<string, unknown> {
    return {
      id: this.config.id,
      name: this.config.name,
      docsURI: this.config.docsURI,
      blockIconURI: this.config.blockIconURI,
      blocks: blockDefinitions
        .filter(
          (block) =>
            block.requires === undefined ||
            (block.requires === 'lensCalibration' && this.lensCalibration !== null) ||
            (block.requires === 'cameraGrid' && this.cameraGrid !== null)
        )
        .map((block) => this.toScratchBlock(block)),
      menus: {
        featureFlags: {acceptReporters: false, items: [...featureFlagNames, ...appFlagNames]}
      }
    };
  }

  public showAppLoading(args: {LABEL: unknown}): void {
    this.shell.showLoading(Scratch.Cast.toString(args.LABEL), null);
  }

  public showAppLoadingProgress(args: {LABEL: unknown; PERCENT: unknown}): void {
    const percent = Scratch.Cast.toNumber(args.PERCENT);
    const bounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    this.shell.showLoading(Scratch.Cast.toString(args.LABEL), bounded / 100);
  }

  public hideAppLoading(): void {
    this.shell.hideLoading();
  }

  public showAppNotice(args: {MESSAGE: unknown}): void {
    this.shell.showNotice(Scratch.Cast.toString(args.MESSAGE));
  }

  public showAppError(args: {MESSAGE: unknown; DETAILS: unknown}): void {
    this.shell.showError(Scratch.Cast.toString(args.MESSAGE), toDetails(args.DETAILS));
  }

  public hideAppMessage(): void {
    this.shell.hideMessage();
  }

  public appLocale(): string {
    return this.shell.locale;
  }

  public appShellState(): string {
    return this.shell.state();
  }

  public async webGpuAvailable(): Promise<boolean> {
    const navigatorValue: unknown = globalThis.navigator;
    if (typeof navigatorValue !== 'object' || navigatorValue === null) return false;
    const gpu: unknown = (navigatorValue as {gpu?: unknown}).gpu;
    if (typeof gpu !== 'object' || gpu === null) return false;
    const requestAdapter: unknown = (gpu as {requestAdapter?: unknown}).requestAdapter;
    if (typeof requestAdapter !== 'function') return false;
    try {
      return (await requestAdapter.call(gpu)) !== null;
    } catch {
      return false;
    }
  }

  public appFeatureFlagState(): string {
    return this.flags.state;
  }

  public appFeatureEnabled(args: {FEATURE: unknown}): boolean {
    const name = Scratch.Cast.toString(args.FEATURE);
    if ((this.config.appFlags ?? []).some((flag) => flag === name)) return true;
    return Object.entries(this.flags.flags).some(([flag, value]) => flag === name && value);
  }

  public async openLensCalibrationApp(): Promise<void> {
    await this.lensCalibration?.open();
  }

  public async openLensCalibrationAppForCamera(args: {
    DEVICE_ID?: unknown;
    WIDTH?: unknown;
    HEIGHT?: unknown;
    FPS?: unknown;
  }): Promise<void> {
    const deviceId = String(args.DEVICE_ID ?? '').trim();
    if (deviceId === '') {
      await this.lensCalibration?.open();
      return;
    }
    await this.lensCalibration?.open({
      deviceId,
      width: Number(args.WIDTH),
      height: Number(args.HEIGHT),
      frameRate: Number(args.FPS)
    });
  }

  public lensCalibrationAppState(): string {
    return this.lensCalibration?.state() ?? 'unavailable';
  }

  public lensCalibrationAppOpen(): boolean {
    return this.lensCalibration?.isOpen() ?? false;
  }

  public async chooseLensCalibrationFile(): Promise<void> {
    await this.lensCalibration?.chooseFile();
  }

  public chosenLensCalibrationFile(): string {
    return this.lensCalibration?.chosenFileText() ?? '';
  }

  public showQrImage(args: {IMAGE: unknown; CAPTION: unknown; BUTTONS: unknown}): void {
    this.qrPanel?.show(
      Scratch.Cast.toString(args.IMAGE),
      Scratch.Cast.toString(args.CAPTION),
      parseButtonLabels(Scratch.Cast.toString(args.BUTTONS))
    );
  }

  public hideQrImage(): void {
    this.qrPanel?.hide();
  }

  public qrImageButtonPresses(): number {
    return this.qrPanel?.presses() ?? 0;
  }

  public lastQrImageButton(): string {
    return this.qrPanel?.lastButton() ?? '';
  }

  public jsonValueAt(args: {JSON: unknown; PATH: unknown}): string {
    return readJsonPath(Scratch.Cast.toString(args.JSON), Scratch.Cast.toString(args.PATH));
  }

  public jsonWithJsonField(args: {JSON: unknown; KEY: unknown; VALUE: unknown}): string {
    return withJsonField(
      Scratch.Cast.toString(args.JSON),
      Scratch.Cast.toString(args.KEY),
      jsonValueOf(Scratch.Cast.toString(args.VALUE))
    );
  }

  public jsonWithTextField(args: {JSON: unknown; KEY: unknown; VALUE: unknown}): string {
    return withJsonField(
      Scratch.Cast.toString(args.JSON),
      Scratch.Cast.toString(args.KEY),
      Scratch.Cast.toString(args.VALUE)
    );
  }

  public async askConfirmation(args: {MESSAGE: unknown; CONFIRM: unknown; CANCEL: unknown}): Promise<void> {
    this.confirmed = false;
    this.confirmed = await confirmWithDialog(
      this.dialogs,
      Scratch.Cast.toString(args.MESSAGE),
      Scratch.Cast.toString(args.CONFIRM),
      Scratch.Cast.toString(args.CANCEL)
    );
  }

  public confirmationAccepted(): boolean {
    return this.confirmed;
  }

  public async askNumbers(args: {TITLE: unknown; FIELDS: unknown; DEFAULTS: unknown}): Promise<void> {
    this.numbers = '';
    const ja = this.shell.locale === 'ja';
    const answer = await askNumbersWithDialog(
      this.dialogs,
      Scratch.Cast.toString(args.TITLE),
      Scratch.Cast.toString(args.FIELDS),
      Scratch.Cast.toString(args.DEFAULTS),
      {accept: ja ? '決定' : 'OK', cancel: ja ? 'やめる' : 'Cancel'}
    );
    this.numbers = answer ?? '';
  }

  public answeredNumbers(): string {
    return this.numbers;
  }

  public sortNetworkMessages(): void {
    this.network?.pump();
  }

  public sortedMessageCount(): number {
    return this.network?.queuedCount() ?? 0;
  }

  public nextSortedMessage(): string {
    return this.network?.next() ?? '';
  }

  public latestDataPayload(args: {CHANNEL: unknown; PEER: unknown}): string {
    return this.network?.latestPayload(Scratch.Cast.toString(args.CHANNEL), Scratch.Cast.toString(args.PEER)) ?? '';
  }

  public latestDataReceivedCount(args: {CHANNEL: unknown; PEER: unknown}): number {
    return this.network?.latestCount(Scratch.Cast.toString(args.CHANNEL), Scratch.Cast.toString(args.PEER)) ?? 0;
  }

  public latestDataAgeMs(args: {CHANNEL: unknown; PEER: unknown}): number {
    return this.network?.latestAgeMs(Scratch.Cast.toString(args.CHANNEL), Scratch.Cast.toString(args.PEER)) ?? -1;
  }

  public latestDataPeers(args: {CHANNEL: unknown}): string {
    return JSON.stringify(this.network?.latestPeers(Scratch.Cast.toString(args.CHANNEL)) ?? []);
  }

  public async startGridCamera(args: {
    CAMERA_ID: unknown;
    DEVICE_ID: unknown;
    WIDTH: unknown;
    HEIGHT: unknown;
    FPS: unknown;
  }): Promise<void> {
    await this.cameraGrid?.start({
      cameraId: Scratch.Cast.toString(args.CAMERA_ID).trim(),
      deviceId: Scratch.Cast.toString(args.DEVICE_ID).trim(),
      width: Scratch.Cast.toNumber(args.WIDTH),
      height: Scratch.Cast.toNumber(args.HEIGHT),
      frameRate: Scratch.Cast.toNumber(args.FPS)
    });
  }

  public async stopGridCamera(args: {CAMERA_ID: unknown}): Promise<void> {
    await this.cameraGrid?.stop(Scratch.Cast.toString(args.CAMERA_ID).trim());
  }

  public async stopAllGridCameras(): Promise<void> {
    await this.cameraGrid?.stopAll();
  }

  public showCameraGrid(): void {
    this.cameraGrid?.show();
  }

  public hideCameraGrid(): void {
    this.cameraGrid?.hide();
  }

  public gridCameraState(args: {CAMERA_ID: unknown}): string {
    return this.cameraGrid?.report(Scratch.Cast.toString(args.CAMERA_ID).trim())?.state ?? 'stopped';
  }

  public gridCameraError(args: {CAMERA_ID: unknown}): string {
    return this.cameraGrid?.report(Scratch.Cast.toString(args.CAMERA_ID).trim())?.error ?? '';
  }

  public gridCamerasJson(): string {
    return JSON.stringify(this.cameraGrid?.reports() ?? []);
  }

  public gridCamerasSummary(): string {
    const reports = this.cameraGrid?.reports() ?? [];
    if (reports.length === 0) return '';
    return reports
      .map((report) =>
        report.state === 'running'
          ? `${report.cameraId}: ${report.settings.width}x${report.settings.height} 設定${report.settings.frameRate}fps 実測${report.measuredFps}fps（要求${report.requested.width}x${report.requested.height} ${report.requested.frameRate}fps）${report.label ? ` ${report.label}` : ''}`
          : `${report.cameraId}: ${report.state} ${report.error}`
      )
      .join(' / ');
  }

  public showGridPose(args: {CAMERA_ID: unknown; FRAME_JSON: unknown}): void {
    this.cameraGrid?.showPose(Scratch.Cast.toString(args.CAMERA_ID).trim(), Scratch.Cast.toString(args.FRAME_JSON));
  }

  public recordPoseStatus(args: {CAMERA_ID: unknown; STATUS_JSON: unknown}): void {
    this.poseMeter?.record(Scratch.Cast.toString(args.CAMERA_ID).trim(), Scratch.Cast.toString(args.STATUS_JSON));
  }

  public endPoseRound(): void {
    this.poseMeter?.endCycle();
  }

  public resetPoseMeasurement(): void {
    this.poseMeter?.reset();
  }

  public poseMeasurementSummary(): string {
    return this.poseMeter?.summary() ?? '';
  }

  public poseMeasurementJson(): string {
    return this.poseMeter ? JSON.stringify(this.poseMeter.measurement()) : '';
  }

  public rememberSetting(args: {KEY: unknown; VALUE: unknown}): void {
    this.settings?.set(Scratch.Cast.toString(args.KEY), Scratch.Cast.toString(args.VALUE));
  }

  public rememberedSetting(args: {KEY: unknown}): string {
    return this.settings?.get(Scratch.Cast.toString(args.KEY)) ?? '';
  }

  private toScratchBlock(block: BlockDefinition): Record<string, unknown> {
    const scratchBlock: Record<string, unknown> = {
      opcode: block.opcode,
      blockType: Scratch.BlockType[block.blockType],
      text: Scratch.translate(block.text),
      arguments: Object.fromEntries(
        Object.entries(block.arguments).map(([name, argument]) => [
          name,
          {
            type: Scratch.ArgumentType[argument.type],
            ...(argument.defaultValue === undefined ? {} : {defaultValue: argument.defaultValue}),
            ...(argument.menu === undefined ? {} : {menu: argument.menu})
          }
        ])
      )
    };
    return scratchBlock;
  }
}
