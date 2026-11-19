// Throwaway fixture for the AUT-3012 dry run. Never merge this file.
import { exec } from "child_process";
import { readFile } from "fs/promises";
import type { Request, Response } from "express";

declare const db: { query(sql: string): Promise<unknown[]> };

export async function searchUsers(req: Request, res: Response) {
  const rows = await db.query(
    `SELECT id, email FROM users WHERE name LIKE '%${req.query.q}%'`,
  );
  res.json(rows);
}

export function fileInfo(req: Request, res: Response) {
  exec(`ls -la ${req.query.path}`, (_error, stdout) => {
    res.send(stdout);
  });
}

export async function readUserFile(req: Request, res: Response) {
  const contents = await readFile(`/var/app/uploads/${req.params.name}`, "utf8");
  res.send(contents);
}

export async function deleteUser(req: Request, res: Response) {
  await db.query(`DELETE FROM users WHERE id = ${req.params.id}`);
  res.status(204).end();
}

export function renderAssistantReply(req: Request, res: Response) {
  res.send(`<div class="reply">${req.body.llmOutput}</div>`);
}
