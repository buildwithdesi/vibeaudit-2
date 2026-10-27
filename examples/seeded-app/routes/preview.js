// Planted class: server-side request forgery.
import { Router } from 'express';

export const previewRouter = Router();

// The server fetches whatever URL the client sends, including internal ones.
previewRouter.post('/', async (req, res) => {
  const upstream = await fetch(req.body.url);
  const text = await upstream.text();
  res.json({ status: upstream.status, length: text.length });
});
