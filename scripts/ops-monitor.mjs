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
// Eight signals:
//   1. report_orders      -> order reached status='processing' (paid, produce report)
//   2. wallet_transactions-> deposit pending manual confirmation (type=deposit, status=pending)
//   3. withdrawal_requests-> withdrawal waiting to be processed (processed_at null, not closed)
//   4. message_threads    -> client message unread for admin (unread_for_admin=true)
//   5. profiles           -> new client signup (excludes admin/master/localizador accounts)
//   6. localizadores      -> localizador completed onboarding (comarcas_atuacao filled in by
//                            the localizador themselves after first login; phone alone doesn't
//                            count, most invites already come with phone pre-filled)
//   7. admin_activity_log -> signup attempt with a CNPJ from a partes_restritas group
//                            (Bradesco/Omni non-compete contract) — hard refusal, no admin
//                            review needed, but Marcelo wants to stay aware of attempts
//   8. admin_activity_log -> signup attempt where declared razão social doesn't match the
//                            CNPJ's official name at Receita Federal (typo or bad faith)

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

  let orders, deposits, withdrawals, threads, newClients, newLocalizadores, cnpjRestricted, cnpjMismatch;
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
        `select wt.id, wt.amount, wt.created_at, wt.pix_txid, p.full_name
         from public.wallet_transactions wt
         left join public.profiles p on p.user_id = wt.user_id
         where wt.type = 'deposit' and wt.status = 'pending'
         order by wt.created_at desc`
      )
    ).rows;
    withdrawals = (
      await client.query(
        `select wr.id, wr.amount, wr.pix_key, wr.status, wr.requested_at, p.full_name
         from public.withdrawal_requests wr
         left join public.profiles p on p.user_id = wr.user_id
         where wr.processed_at is null
           and lower(coalesce(wr.status,'')) not in ('completed','cancelled','canceled','rejected','failed','done')
         order by wr.requested_at desc`
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
    newLocalizadores = (
      await client.query(
        `select l.id, l.nome, l.comarcas_atuacao, l.created_at,
                case
                  when exists (select 1 from public.admin_users au where au.user_id = lc.criado_por) then 'Plataforma'
                  when exists (
                    select 1 from public.user_roles ur
                    where ur.user_id = lc.criado_por and ur.role in ('admin','master')
                  ) then 'Plataforma'
                  else coalesce(p.full_name, 'Cliente')
                end as cadastrado_por
         from public.localizadores l
         left join lateral (
           select criado_por from public.localizador_clientes
           where localizador_id = l.id
           order by created_at asc
           limit 1
         ) lc on true
         left join public.profiles p on p.user_id = lc.criado_por
         where l.comarcas_atuacao is not null and array_length(l.comarcas_atuacao, 1) > 0
         order by l.created_at desc`
      )
    ).rows;
    cnpjRestricted = (
      await client.query(
        `select a.id, a.metadata, a.created_at, p.full_name
         from public.admin_activity_log a
         left join public.profiles p on p.user_id = a.user_id
         where a.action_type = 'cnpj_restricted_attempt'
         order by a.created_at desc`
      )
    ).rows;
    cnpjMismatch = (
      await client.query(
        `select a.id, a.metadata, a.created_at, p.full_name
         from public.admin_activity_log a
         left join public.profiles p on p.user_id = a.user_id
         where a.action_type = 'cnpj_mismatch_attempt'
         order by a.created_at desc`
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
  const curLocalizadores = newLocalizadores.map((l) => l.id);
  const curCnpjRestricted = cnpjRestricted.map((r) => r.id);
  const curCnpjMismatch = cnpjMismatch.map((m) => m.id);

  // First run: baseline everything, alert nothing.
  if (!state.initialized) {
    saveState({
      initialized: true,
      orders_alerted: curOrderIds,
      tx_alerted: curDep,
      wd_alerted: curWd,
      thread_alerted: curThr,
      client_alerted: curClients,
      localizador_alerted: curLocalizadores,
      cnpj_restricted_alerted: curCnpjRestricted,
      cnpj_mismatch_alerted: curCnpjMismatch,
    });
    console.log("baseline established, no alert");
    return;
  }

  const alertedOrders = new Set(arr(state.orders_alerted));
  const alertedDep = new Set(arr(state.tx_alerted));
  const alertedWd = new Set(arr(state.wd_alerted));
  const alertedThr = new Set(arr(state.thread_alerted));
  const alertedClients = new Set(arr(state.client_alerted));
  const alertedLocalizadores = new Set(arr(state.localizador_alerted));
  const alertedCnpjRestricted = new Set(arr(state.cnpj_restricted_alerted));
  const alertedCnpjMismatch = new Set(arr(state.cnpj_mismatch_alerted));

  const newOrders = orders.filter((o) => !alertedOrders.has(o.id));
  const newDeposits = deposits.filter((d) => !alertedDep.has(d.id));
  const newWithdrawals = withdrawals.filter((w) => !alertedWd.has(w.id));
  const newThreads = threads.filter((t) => !alertedThr.has(threadKey(t)));
  const newSignups = newClients.filter((c) => !alertedClients.has(c.id));
  const newLocalizadorProfiles = newLocalizadores.filter((l) => !alertedLocalizadores.has(l.id));
  const newCnpjRestricted = cnpjRestricted.filter((r) => !alertedCnpjRestricted.has(r.id));
  const newCnpjMismatch = cnpjMismatch.filter((m) => !alertedCnpjMismatch.has(m.id));

  // Persist updated state (current actionable sets). No lastRun -> file only
  // changes when a set changes, so the workflow commits only on real activity.
  saveState({
    initialized: true,
    orders_alerted: curOrderIds,
    tx_alerted: curDep,
    wd_alerted: curWd,
    thread_alerted: curThr,
    client_alerted: curClients,
    localizador_alerted: curLocalizadores,
    cnpj_restricted_alerted: curCnpjRestricted,
    cnpj_mismatch_alerted: curCnpjMismatch,
  });

  const total = newOrders.length + newDeposits.length + newWithdrawals.length + newThreads.length + newSignups.length + newLocalizadorProfiles.length + newCnpjRestricted.length + newCnpjMismatch.length;
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
      const name = esc(d.full_name || "(sem nome)");
      out.push(`• ${name} — ${brl(d.amount)} · pendente · ${ts(d.created_at)}`);
    }
  }
  if (newWithdrawals.length) {
    out.push("");
    out.push(`🏧 <b>Saque${newWithdrawals.length > 1 ? "s" : ""} p/ processar (${newWithdrawals.length})</b>`);
    for (const w of newWithdrawals.slice(0, 10)) {
      const name = esc(w.full_name || "(sem nome)");
      out.push(`• ${name} — ${brl(w.amount)} · ${w.status || "pendente"} · ${ts(w.requested_at)}`);
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
  if (newLocalizadorProfiles.length) {
    out.push("");
    out.push(`🕵 <b>Localizador${newLocalizadorProfiles.length > 1 ? "es" : ""} completou cadastro (${newLocalizadorProfiles.length})</b>`);
    for (const l of newLocalizadorProfiles.slice(0, 10)) {
      const name = esc(l.nome || "(sem nome)");
      const comarcas = esc(arr(l.comarcas_atuacao).slice(0, 3).join(", "));
      out.push(`• ${name} · cadastrado por ${esc(l.cadastrado_por)} · ${ts(l.created_at)}`);
      if (comarcas) out.push(`   ${comarcas}`);
    }
  }
  if (newCnpjRestricted.length) {
    out.push("");
    out.push(`🚫 <b>CNPJ restrito tentou se cadastrar (${newCnpjRestricted.length})</b>`);
    for (const r of newCnpjRestricted.slice(0, 10)) {
      const name = esc(r.full_name || "(sem nome)");
      const cnpjRaw = String(r.metadata?.cnpj ?? "");
      const cnpjFmt = esc(cnpjRaw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"));
      out.push(`• ${name} — CNPJ ${cnpjFmt} · ${ts(r.created_at)}`);
    }
  }
  if (newCnpjMismatch.length) {
    out.push("");
    out.push(`⚠️ <b>Divergência de CNPJ no cadastro (${newCnpjMismatch.length})</b>`);
    for (const m of newCnpjMismatch.slice(0, 10)) {
      const name = esc(m.full_name || "(sem nome)");
      const declarado = esc(String(m.metadata?.razao_declarada ?? "?"));
      const oficial = esc(String(m.metadata?.razao_oficial ?? "?"));
      out.push(`• ${name} · ${ts(m.created_at)}`);
      out.push(`   Declarou: "${declarado}"`);
      out.push(`   Oficial: "${oficial}"`);
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
