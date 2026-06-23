import { Request, Response } from 'express';
import * as ministryService from '../services/ministry.service';
import { sendSuccess, sendPaginated } from '../utils/response';
import { AppError } from '../utils/app-error';

export async function list(_req: Request, res: Response): Promise<void> {
  const ministries = await ministryService.listAll();
  sendSuccess(res, ministries);
}

export async function getByCode(req: Request, res: Response): Promise<void> {
  const code = req.params.code as string;
  const ministry = await ministryService.findByCode(code);
  if (!ministry) {
    throw AppError.notFound('Ministry not found');
  }
  const projects = await ministryService.getProjectsByMinistry(code);
  sendSuccess(res, { ministry, ...projects });
}
