import * as crypto from 'crypto';
import * as path from 'path';
import * as fileModel from '../models/file.model';
import { AppError } from '../utils/app-error';
import {
  validateMimeType,
  isAllowedMimeType,
  validateFileSize,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
} from '../utils/file-validation';
import type { FileAttachmentRecord } from '../types/form';

/**
 * Generate a random stored filename using UUID + original extension.
 */
export function generateStoredName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const uuid = crypto.randomUUID();
  return `${uuid}${ext}`;
}

/**
 * Upload a file with validation.
 * Validates MIME type, magic bytes, and file size.
 * Stores in database (BYTEA) by default.
 */
export async function upload(
  file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
  },
  userId: string
): Promise<FileAttachmentRecord> {
  // Validate declared MIME type is in allowlist
  if (!isAllowedMimeType(file.mimetype)) {
    throw AppError.badRequest(
      `File type not allowed. Accepted types: ${ALLOWED_MIME_TYPES.join(', ')}`
    );
  }

  // Validate file size
  if (!validateFileSize(file.size)) {
    throw AppError.badRequest(
      `File size exceeds maximum of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB`
    );
  }

  // Validate magic bytes match declared MIME type
  if (!validateMimeType(file.buffer, file.mimetype)) {
    throw AppError.badRequest(
      'File content does not match declared file type. Possible file type mismatch.'
    );
  }

  // Generate random stored name
  const storedName = generateStoredName(file.originalname);

  // Store in database (BYTEA)
  const attachment = await fileModel.create({
    originalName: file.originalname,
    storedName,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    fileData: file.buffer,
    storageProvider: 'database',
    storagePath: null,
    createdBy: userId,
  });

  return attachment;
}

/**
 * Link uploaded file attachments to a form submission.
 */
export async function linkToSubmission(
  fileIds: string[],
  submissionId: string
): Promise<void> {
  return fileModel.linkToSubmission(fileIds, submissionId);
}
