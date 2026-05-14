declare module 'capacitor-document-scanner' {
  export enum ResponseType {
    Base64 = 'base64',
    ImageFilePath = 'imageFilePath',
  }
  export enum ScanDocumentResponseStatus {
    Success = 'success',
    Cancel = 'cancel',
  }
  export const DocumentScanner: {
    scanDocument(options?: {
      responseType?: ResponseType
      maxNumDocuments?: number
      croppedImageQuality?: number
    }): Promise<{
      scannedImages?: string[]
      status?: ScanDocumentResponseStatus
    }>
  }
}
