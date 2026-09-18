/** The part of `qrcode` the measurement tools use: the symbol as a module matrix. */
declare module 'qrcode' {
  interface BitMatrix {
    readonly size: number;
    get(row: number, column: number): number | boolean;
  }
  interface QrSymbol {
    readonly version: number;
    readonly modules: BitMatrix;
  }
  interface CreateOptions {
    readonly errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  const QRCode: {
    create(text: string, options?: CreateOptions): QrSymbol;
    toBuffer(
      text: string,
      options?: CreateOptions & {
        readonly margin?: number;
        readonly scale?: number;
        readonly type?: 'png';
      },
    ): Promise<Buffer>;
  };
  export default QRCode;
}
