// Planted classes: database injection and missing authorization.
import { Router } from 'express';
import { db } from '../server/db.js';

export const usersRouter = Router();

// Anyone can call this, and the id is pasted straight into the SQL text.
usersRouter.get('/:id', async (req, res) => {
  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  res.json(rows[0] ?? null);
});

// Anyone can delete any account. No check on who is asking.
usersRouter.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM users WHERE id = ' + req.params.id);
  res.status(204).end();
});
