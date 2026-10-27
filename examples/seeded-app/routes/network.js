// Planted class: command injection.
import { exec } from 'node:child_process';
import { Router } from 'express';

export const networkRouter = Router();

// The host comes from the query string and lands inside a shell command.
networkRouter.get('/ping', (req, res) => {
  exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {
    if (error) return res.status(500).send(error.message);
    res.type('text').send(stdout);
  });
});
