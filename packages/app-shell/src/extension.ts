import definitions from './block-definitions.json';
import {
  appFlagNames,
  validateAppConfig,
  type AppShellAppConfig,
} from './app-config.js';
import {
  featureFlagNames,
  type FeatureFlagApplication,
} from './feature-flags.js';
import type { LensCalibrationLauncher } from './lens-calibration.js';
import {
  askNumbersWithDialog,
  confirmWithDialog,
  type DialogHost,
} from './dialogs.js';
import { jsonValueOf, readJsonPath, withJsonField } from './json-fields.js';
import type { NetworkRouter } from './network-router.js';
import type { CameraGrid } from './camera-grid.js';
import type { PoseMeter } from './pose-meter.js';
import type { PoseReplay } from './pose-replay.js';
import type { SettingsStore } from './settings.js';
import { parseButtonLabels, type QrPanel } from './qr-panel.js';
import type { MultiviewPoseShell } from './shell.js';

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
  requires?: 'lensCalibration' | 'cameraGrid' | 'poseReplay';
}

const blockDefinitions = definitions.blocks as readonly BlockDefinition[];

/** Parses the details argument. Anything that is not a JSON object renders as no details at all. */
function toDetails(value: unknown): Record<string, unknown> {
  const text = Scratch.Cast.toString(value).trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {};
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
  private readonly poseReplay: PoseReplay | null;
  private recordings: ReadonlyArray<{
    name: string;
    bytes: number;
    modifiedAt: string;
  }> = [];
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
      poseReplay?: PoseReplay;
      settings?: SettingsStore;
    } = {},
  ) {
    this.config = validateAppConfig(config);
    this.shell = shell;
    this.flags = flags;
    this.lensCalibration = parts.lensCalibration ?? null;
    this.qrPanel = parts.qrPanel ?? null;
    this.dialogs = parts.dialogs ?? { document: null };
    this.network = parts.network ?? null;
    this.cameraGrid = parts.cameraGrid ?? null;
    this.poseMeter = parts.poseMeter ?? null;
    this.poseReplay = parts.poseReplay ?? null;
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
            (block.requires === 'lensCalibration' &&
              this.lensCalibration !== null) ||
            (block.requires === 'cameraGrid' && this.cameraGrid !== null) ||
            (block.requires === 'poseReplay' && this.poseReplay !== null),
        )
        .map((block) => this.toScratchBlock(block)),
      menus: {
        featureFlags: {
          acceptReporters: false,
          items: [...featureFlagNames, ...appFlagNames],
        },
      },
    };
  }

  public showAppLoading(args: { LABEL: unknown }): void {
    this.shell.showLoading(Scratch.Cast.toString(args.LABEL), null);
  }

  public showAppLoadingProgress(args: {
    LABEL: unknown;
    PERCENT: unknown;
  }): void {
    const percent = Scratch.Cast.toNumber(args.PERCENT);
    const bounded = Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : 0;
    this.shell.showLoading(Scratch.Cast.toString(args.LABEL), bounded / 100);
  }

  public hideAppLoading(): void {
    this.shell.hideLoading();
  }

  public showAppNotice(args: { MESSAGE: unknown }): void {
    this.shell.showNotice(Scratch.Cast.toString(args.MESSAGE));
  }

  public showAppError(args: { MESSAGE: unknown; DETAILS: unknown }): void {
    this.shell.showError(
      Scratch.Cast.toString(args.MESSAGE),
      toDetails(args.DETAILS),
    );
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
    if (typeof navigatorValue !== 'object' || navigatorValue === null)
      return false;
    const gpu: unknown = (navigatorValue as { gpu?: unknown }).gpu;
    if (typeof gpu !== 'object' || gpu === null) return false;
    const requestAdapter: unknown = (gpu as { requestAdapter?: unknown })
      .requestAdapter;
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

  public appFeatureEnabled(args: { FEATURE: unknown }): boolean {
    const name = Scratch.Cast.toString(args.FEATURE);
    if ((this.config.appFlags ?? []).some((flag) => flag === name)) return true;
    return Object.entries(this.flags.flags).some(
      ([flag, value]) => flag === name && value,
    );
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
      frameRate: Number(args.FPS),
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

  public showQrImage(args: {
    IMAGE: unknown;
    CAPTION: unknown;
    BUTTONS: unknown;
  }): void {
    this.qrPanel?.show(
      Scratch.Cast.toString(args.IMAGE),
      Scratch.Cast.toString(args.CAPTION),
      parseButtonLabels(Scratch.Cast.toString(args.BUTTONS)),
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

  public jsonValueAt(args: { JSON: unknown; PATH: unknown }): string {
    return readJsonPath(
      Scratch.Cast.toString(args.JSON),
      Scratch.Cast.toString(args.PATH),
    );
  }

  public jsonWithJsonField(args: {
    JSON: unknown;
    KEY: unknown;
    VALUE: unknown;
  }): string {
    return withJsonField(
      Scratch.Cast.toString(args.JSON),
      Scratch.Cast.toString(args.KEY),
      jsonValueOf(Scratch.Cast.toString(args.VALUE)),
    );
  }

  public jsonWithTextField(args: {
    JSON: unknown;
    KEY: unknown;
    VALUE: unknown;
  }): string {
    return withJsonField(
      Scratch.Cast.toString(args.JSON),
      Scratch.Cast.toString(args.KEY),
      Scratch.Cast.toString(args.VALUE),
    );
  }

  public async askConfirmation(args: {
    MESSAGE: unknown;
    CONFIRM: unknown;
    CANCEL: unknown;
  }): Promise<void> {
    this.confirmed = false;
    this.confirmed = await confirmWithDialog(
      this.dialogs,
      Scratch.Cast.toString(args.MESSAGE),
      Scratch.Cast.toString(args.CONFIRM),
      Scratch.Cast.toString(args.CANCEL),
    );
  }

  public confirmationAccepted(): boolean {
    return this.confirmed;
  }

  public async askNumbers(args: {
    TITLE: unknown;
    FIELDS: unknown;
    DEFAULTS: unknown;
  }): Promise<void> {
    this.numbers = '';
    const ja = this.shell.locale === 'ja';
    const answer = await askNumbersWithDialog(
      this.dialogs,
      Scratch.Cast.toString(args.TITLE),
      Scratch.Cast.toString(args.FIELDS),
      Scratch.Cast.toString(args.DEFAULTS),
      { accept: ja ? '決定' : 'OK', cancel: ja ? 'やめる' : 'Cancel' },
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

  public latestDataPayload(args: { CHANNEL: unknown; PEER: unknown }): string {
    return (
      this.network?.latestPayload(
        Scratch.Cast.toString(args.CHANNEL),
        Scratch.Cast.toString(args.PEER),
      ) ?? ''
    );
  }

  public latestDataReceivedCount(args: {
    CHANNEL: unknown;
    PEER: unknown;
  }): number {
    return (
      this.network?.latestCount(
        Scratch.Cast.toString(args.CHANNEL),
        Scratch.Cast.toString(args.PEER),
      ) ?? 0
    );
  }

  public latestDataAgeMs(args: { CHANNEL: unknown; PEER: unknown }): number {
    return (
      this.network?.latestAgeMs(
        Scratch.Cast.toString(args.CHANNEL),
        Scratch.Cast.toString(args.PEER),
      ) ?? -1
    );
  }

  public latestDataPeers(args: { CHANNEL: unknown }): string {
    return JSON.stringify(
      this.network?.latestPeers(Scratch.Cast.toString(args.CHANNEL)) ?? [],
    );
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
      frameRate: Scratch.Cast.toNumber(args.FPS),
    });
  }

  public async stopGridCamera(args: { CAMERA_ID: unknown }): Promise<void> {
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

  public gridCameraState(args: { CAMERA_ID: unknown }): string {
    return (
      this.cameraGrid?.report(Scratch.Cast.toString(args.CAMERA_ID).trim())
        ?.state ?? 'stopped'
    );
  }

  public gridCameraError(args: { CAMERA_ID: unknown }): string {
    return (
      this.cameraGrid?.report(Scratch.Cast.toString(args.CAMERA_ID).trim())
        ?.error ?? ''
    );
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
          : `${report.cameraId}: ${report.state} ${report.error}`,
      )
      .join(' / ');
  }

  public showGridPose(args: { CAMERA_ID: unknown; FRAME_JSON: unknown }): void {
    this.cameraGrid?.showPose(
      Scratch.Cast.toString(args.CAMERA_ID).trim(),
      Scratch.Cast.toString(args.FRAME_JSON),
    );
  }

  public recordPoseStatus(args: {
    CAMERA_ID: unknown;
    STATUS_JSON: unknown;
  }): void {
    this.poseMeter?.record(
      Scratch.Cast.toString(args.CAMERA_ID).trim(),
      Scratch.Cast.toString(args.STATUS_JSON),
    );
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

  public poseFrameAgeMs(args: { FRAME_JSON: unknown }): number {
    return (
      this.poseMeter?.frameAgeMs(Scratch.Cast.toString(args.FRAME_JSON)) ?? -1
    );
  }

  public poseMeasurementJson(): string {
    return this.poseMeter ? JSON.stringify(this.poseMeter.measurement()) : '';
  }

  public startPoseRecording(args: { CONFIGURATION_JSON: unknown }): void {
    this.poseReplay?.startRecording(
      Scratch.Cast.toString(args.CONFIGURATION_JSON),
    );
  }

  public recordPoseFrame(args: {
    FRAME_JSON: unknown;
    CAMERA_ID: unknown;
  }): void {
    this.poseReplay?.recordFrame(
      Scratch.Cast.toString(args.CAMERA_ID).trim(),
      Scratch.Cast.toString(args.FRAME_JSON),
    );
  }

  public recordSpaceTimeResult(args: {
    PAYLOAD_JSON: unknown;
    CAMERA_ID: unknown;
  }): void {
    this.poseReplay?.recordSpaceTime(
      Scratch.Cast.toString(args.CAMERA_ID).trim(),
      Scratch.Cast.toString(args.PAYLOAD_JSON),
    );
  }

  public replaySpaceTimePayload(args: { CAMERA_ID: unknown }): string {
    return (
      this.poseReplay?.spaceTimePayloadJson(
        Scratch.Cast.toString(args.CAMERA_ID).trim(),
      ) ?? ''
    );
  }

  public stopPoseRecording(): void {
    this.poseReplay?.stopRecording();
  }

  public poseRecordingState(): string {
    return this.poseReplay?.recordingStateName() ?? 'idle';
  }

  public poseRecordingSummary(): string {
    return this.poseReplay?.recordingSummary() ?? '';
  }

  public async saveRecording(args: { NAME: unknown }): Promise<void> {
    await this.poseReplay?.save(Scratch.Cast.toString(args.NAME));
  }

  public async refreshRecordings(): Promise<void> {
    this.recordings = (await this.poseReplay?.listRecordings()) ?? [];
  }

  public recordingCount(): number {
    return this.recordings.length;
  }

  public recordingNameAt(args: { INDEX: unknown }): string {
    return (
      this.recordings[Math.round(Scratch.Cast.toNumber(args.INDEX)) - 1]
        ?.name ?? ''
    );
  }

  public recordingsSummary(): string {
    if (this.recordings.length === 0) return '';
    return this.recordings
      .map(
        (entry) =>
          `${entry.name}（${Math.round(entry.bytes / 1024)} KB / ${entry.modifiedAt.slice(0, 16).replace('T', ' ')}）`,
      )
      .join(' / ');
  }

  public async loadRecording(args: { NAME: unknown }): Promise<void> {
    await this.poseReplay?.load(Scratch.Cast.toString(args.NAME));
  }

  public startPoseReplay(): void {
    this.poseReplay?.startReplay();
  }

  public stopPoseReplay(): void {
    this.poseReplay?.stopReplay();
  }

  public replayPoseFrame(args: { CAMERA_ID: unknown }): string {
    return (
      this.poseReplay?.frameFor(Scratch.Cast.toString(args.CAMERA_ID).trim()) ??
      ''
    );
  }

  public replayState(): string {
    return this.poseReplay?.replayStateName() ?? 'idle';
  }

  public replayPositionMs(): number {
    return this.poseReplay?.replayPositionMs() ?? 0;
  }

  public replayDurationMs(): number {
    return this.poseReplay?.replayDurationMs() ?? 0;
  }

  public replayConfigurationJson(): string {
    return this.poseReplay?.loadedConfigurationJson() ?? '';
  }

  public replayCamerasJson(): string {
    return this.poseReplay?.loadedCamerasJson() ?? '[]';
  }

  public replaySummary(): string {
    return this.poseReplay?.loadedSummary() ?? '';
  }

  public poseReplayError(): string {
    return this.poseReplay?.errorMessage() ?? '';
  }

  public rememberSetting(args: { KEY: unknown; VALUE: unknown }): void {
    this.settings?.set(
      Scratch.Cast.toString(args.KEY),
      Scratch.Cast.toString(args.VALUE),
    );
  }

  public rememberedSetting(args: { KEY: unknown }): string {
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
            ...(argument.defaultValue === undefined
              ? {}
              : { defaultValue: argument.defaultValue }),
            ...(argument.menu === undefined ? {} : { menu: argument.menu }),
          },
        ]),
      ),
    };
    return scratchBlock;
  }
}
