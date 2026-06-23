/**
 * File validation utility.
 * Validates file types by inspecting magic bytes (file signatures).
 * Ensures that the actual file content matches the declared MIME type.
 */

/** Allowed MIME types for file uploads */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMimeType = typeof ALLOWED_MIME_TYPES[number];

/** Maximum file size in bytes (10 MB) */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Magic byte signatures for supported file types.
 * Each entry maps a MIME type to one or more byte patterns to check.
 */
interface MagicBytePattern {
  mimeType: AllowedMimeType;
  bytes: number[];
  offset?: number;
}

const MAGIC_BYTE_PATTERNS: MagicBytePattern[] = [
  // JPEG: starts with FF D8 FF
  { mimeType: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  // PNG: starts with 89 50 4E 47 0D 0A 1A 0A
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  // WEBP: starts with RIFF at 0, WEBP at offset 8
  { mimeType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
  // PDF: starts with %PDF
  { mimeType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/**
 * Detect file type from magic bytes in the buffer.
 * Returns the detected MIME type or null if unrecognized.
 */
export function detectMimeType(buffer: Buffer): AllowedMimeType | null {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  for (const pattern of MAGIC_BYTE_PATTERNS) {
    const offset = pattern.offset || 0;
    if (buffer.length < offset + pattern.bytes.length) {
      continue;
    }

    let match = true;
    for (let i = 0; i < pattern.bytes.length; i++) {
      if (buffer[offset + i] !== pattern.bytes[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      // Extra check for WEBP: must also have "WEBP" at offset 8
      if (pattern.mimeType === 'image/webp') {
        if (buffer.length >= 12) {
          const webpSignature = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
          let webpMatch = true;
          for (let i = 0; i < webpSignature.length; i++) {
            if (buffer[8 + i] !== webpSignature[i]) {
              webpMatch = false;
              break;
            }
          }
          if (webpMatch) return 'image/webp';
        }
        continue; // RIFF header matched but not WEBP
      }
      return pattern.mimeType;
    }
  }

  return null;
}

/**
 * Validate that a declared MIME type is in the allowed list.
 */
export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Validate that detected magic bytes match the declared MIME type.
 * Returns true if the actual content matches what was declared.
 */
export function validateMimeType(buffer: Buffer, declaredType: string): boolean {
  if (!isAllowedMimeType(declaredType)) {
    return false;
  }

  const detected = detectMimeType(buffer);
  if (!detected) {
    return false;
  }

  return detected === declaredType;
}

/**
 * Validate file size is within the maximum allowed limit.
 */
export function validateFileSize(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}
