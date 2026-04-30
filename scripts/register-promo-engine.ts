/**
 * Register the promo-engine scheduled task.
 *
 * Usage:
 *   npx tsx scripts/register-promo-engine.ts [--group-folder main] [--chat-jid <jid>]
 *
 * Creates a daily cron task at 9:00 AM AST (13:00 UTC) that runs the
 * promo-engine skill to check the Aruba events calendar and generate
 * promotional proposals for CJS website.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'nanoclaw.db');

// Parse CLI args
const args = process.argv.slice(2);
const groupFolder = args.includes('--group-folder')
  ? args[args.indexOf('--group-folder') + 1]
  : 'main';
const chatJid = args.includes('--chat-jid')
  ? args[args.indexOf('--chat-jid') + 1]
  : '';

if (!chatJid) {
  // Try to find the main group's chat JID from the database
  const db = new Database(DB_PATH);
  const row = db.prepare(
    `SELECT chat_jid FROM registered_groups WHERE folder = ? LIMIT 1`
  ).get(groupFolder) as { chat_jid: string } | undefined;
  db.close();

  if (!row) {
    console.error(
      `No registered group found with folder "${groupFolder}".`
    );
    console.error(
      'Usage: npx tsx scripts/register-promo-engine.ts --chat-jid <jid>'
    );
    process.exit(1);
  }

  registerTask(groupFolder, row.chat_jid);
} else {
  registerTask(groupFolder, chatJid);
}

function registerTask(folder: string, jid: string): void {
  const db = new Database(DB_PATH);

  // Check if a promo-engine task already exists
  const existing = db.prepare(
    `SELECT id FROM scheduled_tasks WHERE prompt LIKE '%promo-engine%' AND status = 'active'`
  ).get() as { id: string } | undefined;

  if (existing) {
    console.log(`Promo-engine task already exists (id: ${existing.id}). Skipping.`);
    db.close();
    return;
  }

  // 9:00 AM AST = 13:00 UTC (AST is UTC-4)
  const cronExpression = '0 13 * * *';
  const taskId = randomUUID();

  // Compute next run
  const interval = CronExpressionParser.parse(cronExpression, { tz: 'America/Aruba' });
  const nextRun = interval.next().toISOString();

  const prompt = `You are running the promo-engine skill. Read /workspace/skills/promo-engine/SKILL.md and follow the instructions exactly. Check the Aruba events calendar, query Odoo inventory, and generate promotional proposals for any upcoming events. This is a scheduled daily check.`;

  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, 'cron', ?, 'group', ?, 'active', datetime('now'))
  `).run(taskId, folder, jid, prompt, cronExpression, nextRun);

  console.log('Promo-engine scheduled task registered:');
  console.log(`  ID: ${taskId}`);
  console.log(`  Group: ${folder}`);
  console.log(`  Chat JID: ${jid}`);
  console.log(`  Schedule: ${cronExpression} (daily at 9:00 AM AST)`);
  console.log(`  Next run: ${nextRun}`);

  db.close();
}
