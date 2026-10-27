// Planted class: file path traversal.
import path from 'node:path';
import { Router } from 'express';

export const filesRouter = Router();
const UPLOADS = path.join(process.cwd(), 'uploads');

// "../../etc/passwd" walks right out of the uploads folder.
filesRouter.get('/download', (req, res) => {
  res.sendFile(path.join(UPLOADS, req.query.file));
});
