// Seeded demo app for Vibe Audit 2.0. Every route below carries one planted
// vulnerability class. Never deploy this. It exists so the pipeline has a
// known "before" state to scan, reason about, patch, and re-scan.
import express from 'express';
import { filesRouter } from '../routes/files.js';
import { networkRouter } from '../routes/network.js';
import { previewRouter } from '../routes/preview.js';
import { usersRouter } from '../routes/users.js';

const app = express();
app.use(express.json());
app.use('/users', usersRouter);
app.use('/network', networkRouter);
app.use('/files', filesRouter);
app.use('/preview', previewRouter);

app.listen(3000, () => {
  console.log('seeded app listening on 3000');
});
