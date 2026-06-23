import { Request, Response } from 'express';
import * as fileService from '../services/file.service';
import { sendSuccess } from '../utils/response';

/**
 * POST /api/files/upload
 * Upload a file with validation.
 * Accepts multipart/form-data via multer.
 * Requires authentication + CSRF.
 */
export async function uploadFile(req: Request, res: Response): Promise<void> {
  const file = req.file;

  if (!file) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'No file provided' },
    });
    return;
  }

  const userId = req.user!.id;

  const attachment = await fileService.upload(
    {
      originalname: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
      size: file.size,
    },
    userId
  );

  sendSuccess(res, {
    pk_file_attachment: attachment.pk_file_attachment,
    file_original_name: attachment.file_original_name,
    file_mime_type: attachment.file_mime_type,
    file_size_bytes: attachment.file_size_bytes,
  }, 201);
}
