#!/usr/bin/env node
// NexusRota OPERATIONAL monitor (GitHub Actions edition).
// Read-only against Supabase (role nexusrota_monitor_ro). Sends a Telegram HTML
// alert directly via the Bot API when there is something NEW to act on.
//
// Differences vs the local/OpenClaw version:
//   - Secrets come from env vars (SUPABASE_CONN, TELEGRAM_*), not files.
//   - Alerts are POSTed straight to Telegram (no OpenClaw announce layer).
//   - State lives in ./state/ops.json inside the repo; the workflow commits it
//     back only when the actionable sets actually change (no lastRun => no noise).
//
// Five signals:
//   1. report_orders      -> order reached status='processing' (paid, produce report)
//   2. wallet_transactions-> deposit pending manual confirmation (type=deposit, status=pending)
//   3. withdrawal_requests-> withdrawal waiting to be processed (processed_at null, not closed)
//   4. message_threads    -> client message unread for admin (unread_for_admin=true)
//   5. profiles           -> new client signup (excludes admin/master/localizador accounts)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { sendTelegram } from "./lib/telegram.mjs";

const STATE_FILE = process.env.OPS_STATE_FILE || resolve("state/ops.json");
const ORDER_ACTION_STATUS = "processing";

function loadConn() {
  const c = process.env.SUPABASE_CONN;
  if (!c) throw new Error("SUPABASE_CONN not set");
  return c;
}
function loadState() {
  if (!existsSync(STATE_FILE)) return { initialized: false };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { initialized: false };
  }
}
function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}
function brl(v) {
  return "R$ " + Number(v).toFixed(2).replace(".", ",");
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function ts(d) {
  if (!d) return "";
  return new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
const arr = (x) => (Array.isArray(x) ? x : []);

async function main() {
  const state = loadState();
  const client = new pg.Client({
    connectionString: loadConn(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
    query_timeout: 12000,
    statement_timeout: 12000,
    keepAlive: true,
  });
  await client.connect();

  let orders, deposits, withdrawals, threads, newClients;
  try {
    orders = (
      await client.query(
        `select id, vehicle_plate, amount, status::text, created_at, updated_at
         from public.report_orders
         where status = $1
         order by updated_at desc`,
        [ORDER_ACTION_STATUS]
      )
    ).rows;
    deposits = (
      await client.query(
        `select id, amount, created_at, pix_txid
         from public.wallet_transactions
         where type = 'deposit' and status = 'pending'
         order by created_at desc`
      )
    ).rows;
    withdrawals = (
      await client.query(
        `select id, amount, pix_key, status, requested_at
         from public.withdrawal_requests
         where processed_at is null
           and lower(coalesce(status,'')) not in ('completed','cancelled','canceled','rejected','failed','done')
         order by requested_at desc`
      )
    ).rows;
    threads = (
      await client.query(
        `select t.id, t.subject, t.subject_type, t.vehicle_plate, t.last_message_at,
                (select tm.body from public.thread_messages tm
                 where tm.thread_id = t.id and coalesce(tm.is_admin, false) = false
                 order by tm.created_at desc limit 1) as last_client_msg,
                (select tm.id from public.thread_messages tm
                 where tm.thread_id = t.id and coalesce(tm.is_admin, false) = false
                 order by tm.created_at desc limit 1) as last_client_msg_id
         from public.message_threads t
         where t.unread_for_admin = true
         order by t.last_message_at desc nulls last`
      )
    ).rows;
    newClients = (
      await client.query(
        `select p.id, p.full_name, p.requestor_type::text as requestor_type, p.created_at
         from public.profiles p
         where not exists (select 1 from public.admin_users au where au.user_id = p.user_id)
           and not exists (
             select 1 from public.user_roles ur
             where ur.user_id = p.user_id and ur.role in ('admin','master','localizador')
           )
         order by p.created_at desc`
      )
    ).rows;
  } finally {
    await client.end().catch(() => {});
  }

  // Threads are keyed by thread_id + latest client message id, not thread_id
  // alone: unread_for_admin is a single boolean per thread (set by a trigger
  // that never resets while unread), so a second new message on a thread the
  // admin hasn't read yet would otherwise look identical to the first.
  const threadKey = (t) => `${t.id}:${t.last_client_msg_id ?? ""}`;

  const curOrderIds = orders.map((o) => o.id);
  const curDep = deposits.map((d) => d.id);
  const curWd = withdrawals.map((w) => w.id);
  const curThr = threads.map(threadKey);
  const curClients = newClients.map((c) => c.id);

  // First run: baseline everything, alert nothing.
  if (!state.initialized) {
    saveState({
      initialized: true,
      orders_alerted: curOrderIds,
      tx_alerted: curDep,
      wd_alerted: curWd,
      thread_alerted: curThr,
      client_alerted: curClients,
    });
    console.log("baseline established, no alert");
    return;
  }

  const alertedOrders = new Set(arr(state.orders_alerted));
  const alertedDep = new Set(arr(state.tx_alerted));
  const alertedWd = new Set(arr(state.wd_alerted));
  const alertedThr = new Set(arr(state.thread_alerted));
  const alertedClients = new Set(arr(state.client_alerted));

  const newOrders = orders.filter((o) => !alertedOrders.has(o.id));
  const newDeposits = deposits.filter((d) => !alertedDep.has(d.id));
  const newWithdrawals = withdrawals.filter((w) => !alertedWd.has(w.id));
  const newThreads = threads.filter((t) => !alertedThr.has(threadKey(t)));
  const newSignups = newClients.filter((c) => !alertedClients.has(c.id));

  // Persist updated state (current actionable sets). No lastRun -> file only
  // changes when a set changes, so the workflow commits only on real activity.
  saveState({
    initialized: true,
    orders_alerted: curOrderIds,
    tx_alerted: curDep,
    wd_alerted: curWd,
    thread_alerted: curThr,
    client_alerted: curClients,
  });

  const total = newOrders.length + newDeposits.length + newWithdrawals.length + newThreads.length + newSignups.length;
  if (total === 0) {
    console.log("no new actionable items");
    return;
  }

  const out = ["🛰 <b>NexusRota — ação necessária</b>"];

  if (newOrders.length) {
    out.push("");
    out.push(`📄 <b>Pedido${newOrders.length > 1 ? "s" : ""} pago${newOrders.length > 1 ? "s" : ""} — produzir relatório (${newOrders.length})</b>`);
    for (const o of newOrders.slice(0, 10)) {
      const plate = o.vehicle_plate ? ` · ${esc(o.vehicle_plate)}` : "";
      out.push(`• ${brl(o.amount)}${plate} · ${ts(o.updated_at || o.created_at)}`);
    }
  }
  if (newDeposits.length) {
    out.push("");
    out.push(`💰 <b>Depósito${newDeposits.length > 1 ? "s" : ""} p/ confirmar (${newDeposits.length})</b>`);
    for (const d of newDeposits.slice(0, 10)) {
      out.push(`• ${brl(d.amount)} — pendente · ${ts(d.created_at)}`);
    }
  }
  if (newWithdrawals.length) {
    out.push("");
    out.push(`🏧 <b>Saque${newWithdrawals.length > 1 ? "s" : ""} p/ processar (${newWithdrawals.length})</b>`);
    for (const w of newWithdrawals.slice(0, 10)) {
      out.push(`• ${brl(w.amount)} — ${w.status || "pendente"} · ${ts(w.requested_at)}`);
    }
  }
  if (newThreads.length) {
    out.push("");
    out.push(`💬 <b>Mensagem${newThreads.length > 1 ? "s" : ""} de cliente (${newThreads.length})</b>`);
    for (const t of newThreads.slice(0, 10)) {
      const subj = esc((t.subject || t.subject_type || "sem assunto").slice(0, 40));
      const plate = t.vehicle_plate ? ` · ${esc(t.vehicle_plate)}` : "";
      out.push(`• ${subj}${plate} · ${ts(t.last_message_at)}`);
      if (t.last_client_msg) {
        const msg = esc(String(t.last_client_msg).replace(/\s+/g, " ").slice(0, 160));
        out.push(`   “${msg}”`);
      }
    }
  }
  if (newSignups.length) {
    const typeLabel = { advogado: "Advogado", locadora: "Locadora", financeira: "Financeira" };
    out.push("");
    out.push(`👤 <b>Novo${newSignups.length > 1 ? "s" : ""} cliente${newSignups.length > 1 ? "s" : ""} cadastrado${newSignups.length > 1 ? "s" : ""} (${newSignups.length})</b>`);
    for (const c of newSignups.slice(0, 10)) {
      const name = esc(c.full_name || "(sem nome)");
      const type = typeLabel[c.requestor_type] || c.requestor_type || "?";
      out.push(`• ${name} · ${type} · ${ts(c.created_at)}`);
    }
  }

  await sendTelegram(out.join("\n"));
  console.log(`alert sent (${total} item(s))`);
}

// Hard wall-clock watchdog: force-exit if pg hangs on a half-open pooler socket.
const HARD_TIMEOUT_MS = 30000;
const watchdog = setTimeout(() => {
  console.error("ops-monitor: hard timeout — forcing exit");
  process.exit(1);
}, HARD_TIMEOUT_MS);

main()
  .then(() => clearTimeout(watchdog))
  .catch((e) => {
    clearTimeout(watchdog);
    console.error(`ops-monitor error: ${e.message}`);
    process.exit(1);
  });
