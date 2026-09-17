import definitions from './block-definitions.json';
import {validateAppConfig, type AppShellAppConfig} from './app-config.js';
import {featureFlagNames, type FeatureFlagApplication} from './feature-flags.js';
import type {LensCalibrationLauncher} from './lens-calibration.js';
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
  requires?: 'lensCalibration';
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

  public constructor(
    config: AppShellAppConfig,
    shell: MultiviewPoseShell,
    flags: FeatureFlagApplication,
    parts: {lensCalibration?: LensCalibrationLauncher; qrPanel?: QrPanel} = {}
  ) {
    this.config = validateAppConfig(config);
    this.shell = shell;
    this.flags = flags;
    this.lensCalibration = parts.lensCalibration ?? null;
    this.qrPanel = parts.qrPanel ?? null;
  }

  public getInfo(): Record<string, unknown> {
    return {
      id: this.config.id,
      name: this.config.name,
      docsURI: this.config.docsURI,
      blockIconURI: this.config.blockIconURI,
      blocks: blockDefinitions
        .filter((block) => block.requires === undefined || this.lensCalibration !== null)
        .map((block) => this.toScratchBlock(block)),
      menus: {
        featureFlags: {acceptReporters: false, items: [...featureFlagNames]}
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
    return Object.entries(this.flags.flags).some(([flag, value]) => flag === name && value);
  }

  public async openLensCalibrationApp(): Promise<void> {
    await this.lensCalibration?.open();
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
