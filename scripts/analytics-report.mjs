#!/usr/bin/env node
// Monthly Web Analytics PDF report (GitHub Actions edition).
// Queries the Vercel Web Analytics REST API for the previous calendar month,
// builds a PDF with pdfkit (tables only — no headless browser/chart image,
// keeps the run light and reliable on a monthly cron), and sends it to
// Telegram as a document. Same VERCEL_TOKEN/VERCEL_TEAM_ID/TELEGRAM_* secrets
// already used by vercel-monitor.mjs/ops-monitor.mjs.

import PDFDocument from "pdfkit";
import pg from "pg";
import { sendTelegramDocument } from "./lib/telegram.mjs";

const PROJECT = "nexusrota";
const TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const API_BASE = "https://api.vercel.com/v1/query/web-analytics";

const NAVY = "#152238";
const GOLD = "#b8902a";
const MUTED = "#6b7280";

// Limites fixos do plano Free do Supabase — não vêm de nenhuma API, são o
// teto documentado do plano em si.
const DB_LIMIT_BYTES = 500 * 1024 ** 2;
const STORAGE_LIMIT_BYTES = 1024 ** 3;

function loadToken() {
  const t = process.env.VERCEL_TOKEN;
  if (!t) throw new Error("VERCEL_TOKEN not set");
  return t;
}

function loadSupabaseConn() {
  const c = process.env.SUPABASE_CONN;
  if (!c) throw new Error("SUPABASE_CONN not set");
  return c;
}

// Mesmo padrão de conexão do ops-monitor.mjs — timeouts curtos, sempre fecha
// no finally, pra nunca deixar o job monthly preso numa conexão pendurada.
async function fetchCapacity() {
  const client = new pg.Client({
    connectionString: loadSupabaseConn(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
    query_timeout: 12000,
    statement_timeout: 12000,
    keepAlive: true,
  });
  await client.connect();
  try {
    const dbSize = (await client.query(`select pg_database_size(current_database()) as bytes`)).rows[0].bytes;
    const buckets = (
      await client.query(
        `select bucket_id, sum((metadata->>'size')::bigint) as bytes, count(*) as num_files
         from storage.objects group by bucket_id order by bytes desc`
      )
    ).rows;
    return { dbBytes: Number(dbSize), buckets };
  } finally {
    await client.end().catch(() => {});
  }
}

async function vercelQuery(token, path, params) {
  const qs = new URLSearchParams({ projectId: PROJECT, teamId: TEAM_ID, ...params });
  const res = await fetch(`${API_BASE}${path}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`vercel ${path}: HTTP ${res.status} — ${json?.error?.message || ""}`);
  return json?.data ?? [];
}

// Últimos 30 dias corridos (não mês calendário) — o plano Hobby da Vercel só
// permite consultar os últimos 31 dias de Web Analytics; um mês calendário
// fechado (que pode ter 31 dias) rodando com qualquer atraso já estoura esse
// limite e a API responde 400. 30 dias corridos até "agora" sempre cabe.
function last30DaysRange(now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const label = `${fmt(since)} a ${fmt(now)}`;
  return { since: since.toISOString(), until: now.toISOString(), label };
}

function sumMetric(rows, key) {
  return rows.reduce((acc, r) => acc + (typeof r[key] === "number" ? r[key] : 0), 0);
}

// Descobre as colunas numéricas realmente presentes numa linha (evita
// depender só de "visitors"/"views" caso a Vercel mude/adicione campos).
function metricKeys(rows, exclude) {
  const keys = new Set();
  rows.forEach((r) => Object.entries(r).forEach(([k, v]) => { if (!exclude.includes(k) && typeof v === "number") keys.add(k); }));
  const order = ["visitors", "views"];
  return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b) || a.localeCompare(b));
}

const METRIC_LABELS = { visitors: "Visitantes", views: "Page views", num_files: "Arquivos" };
const label = (k) => METRIC_LABELS[k] || k;

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function mb(bytes) {
  return (bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function drawCapacitySection(doc, { dbBytes, buckets }) {
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const startX = doc.page.margins.left;

  ensureSpace(doc, 80);
  doc.moveDown(0.6);
  doc.fontSize(12).fillColor(NAVY).font("Helvetica-Bold").text("Capacidade da infraestrutura (Supabase Free)", startX, doc.y, { width: fullWidth });
  doc.moveDown(0.3);

  const storageBytes = buckets.reduce((acc, b) => acc + Number(b.bytes || 0), 0);
  const dbPct = ((dbBytes / DB_LIMIT_BYTES) * 100).toFixed(1);
  const storagePct = ((storageBytes / STORAGE_LIMIT_BYTES) * 100).toFixed(1);

  doc.fontSize(9).fillColor("#333").font("Helvetica");
  doc.text(`Banco de dados: ${mb(dbBytes)} MB de 500 MB (${dbPct}%)`, startX, doc.y, { width: fullWidth });
  doc.text(`Storage: ${mb(storageBytes)} MB de 1024 MB (${storagePct}%)`, startX, doc.y, { width: fullWidth });

  drawTable(doc, {
    title: "Storage por bucket",
    dimensionLabel: "Bucket",
    dimensionKey: "bucket_id",
    exclude: ["bucket_id", "bytes"],
    rows: buckets.map((b) => ({ bucket_id: b.bucket_id, num_files: Number(b.num_files), "MB": Number(mb(b.bytes).replace(",", ".")) })),
  });

  doc.moveDown(0.4);
  doc.fontSize(8).fillColor(MUTED).font("Helvetica").text(
    "Vercel: plano Hobby — upgrade para Pro previsto só quando entrar o primeiro cliente pagante (decisão registrada em docs/AMBIENTES-QA-PRD.md).",
    startX, doc.y, { width: fullWidth }
  );
}

function drawTable(doc, { title, dimensionLabel, dimensionKey, rows, exclude }) {
  const cols = metricKeys(rows, exclude);
  if (rows.length === 0) return;

  ensureSpace(doc, 60);
  doc.moveDown(0.6);
  const startX = doc.page.margins.left;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // x/y/width explicitos — sem isso o cursor do pdfkit fica na ultima coluna
  // (alinhada a direita) da tabela anterior, e o titulo sai desalinhado.
  doc.fontSize(12).fillColor(NAVY).font("Helvetica-Bold").text(title, startX, doc.y, { width: fullWidth });
  doc.moveDown(0.3);
  const metricWidth = 90;
  const dimWidth = fullWidth - metricWidth * cols.length;
  const colWidths = [dimWidth, ...cols.map(() => metricWidth)];
  const rowHeight = 16;

  function drawRow(cells, y, header, shaded) {
    if (shaded) doc.rect(startX, y - 2, fullWidth, rowHeight).fill("#f4f1e8");
    doc.fillColor(header ? NAVY : "#333").font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    let x = startX;
    cells.forEach((c, i) => {
      doc.text(String(c), x + 2, y, { width: colWidths[i] - 4, align: i === 0 ? "left" : "right" });
      x += colWidths[i];
    });
  }

  let y = doc.y;
  drawRow([dimensionLabel, ...cols.map(label)], y, true, false);
  y += rowHeight;
  doc.moveTo(startX, y - 3).lineTo(startX + fullWidth, y - 3).strokeColor(GOLD).lineWidth(0.5).stroke();

  rows.forEach((r, i) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow([dimensionLabel, ...cols.map(label)], y, true, false);
      y += rowHeight;
    }
    drawRow([r[dimensionKey] ?? "—", ...cols.map((k) => (typeof r[k] === "number" ? r[k].toLocaleString("pt-BR") : "—"))], y, false, i % 2 === 1);
    y += rowHeight;
  });

  doc.y = y + 6;
}

export async function buildReport({ since, until, label: monthLabel, byDay, byRoute, byCountry, byReferrer, byDevice, byBrowser, byOS, capacity }) {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  doc.fontSize(22).fillColor(NAVY).font("Helvetica-Bold").text("NexusRota");
  doc.fontSize(13).fillColor(GOLD).font("Helvetica-Bold").text(`Relatório de Analytics da LP — ${monthLabel}`);
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor(MUTED).font("Helvetica").text("Dados via Vercel Web Analytics.");
  doc.moveTo(doc.page.margins.left, doc.y + 8).lineTo(doc.page.width - doc.page.margins.right, doc.y + 8).strokeColor(GOLD).lineWidth(1).stroke();
  doc.moveDown(1.2);

  const totalVisitors = sumMetric(byDay, "visitors");
  const totalViews = sumMetric(byDay, "views");
  doc.fontSize(11).fillColor(NAVY).font("Helvetica-Bold").text(`Visitantes: ${totalVisitors.toLocaleString("pt-BR")}`, { continued: true });
  doc.text("     ");
  doc.text(`Page views: ${totalViews.toLocaleString("pt-BR")}`);
  doc.moveDown(0.8);

  drawTable(doc, { title: "Visitas por dia", dimensionLabel: "Dia", dimensionKey: "timestamp", exclude: ["timestamp"],
    rows: byDay.map((r) => ({ ...r, timestamp: new Date(r.timestamp).toLocaleDateString("pt-BR", { timeZone: "UTC" }) })) });
  drawTable(doc, { title: "Top páginas", dimensionLabel: "Página", dimensionKey: "route", exclude: ["route"], rows: byRoute });
  drawTable(doc, { title: "Países", dimensionLabel: "País", dimensionKey: "country", exclude: ["country"], rows: byCountry });
  drawTable(doc, { title: "De onde vieram (referrer)", dimensionLabel: "Origem", dimensionKey: "referrerHostname", exclude: ["referrerHostname"], rows: byReferrer });
  drawTable(doc, { title: "Dispositivo", dimensionLabel: "Dispositivo", dimensionKey: "deviceType", exclude: ["deviceType"], rows: byDevice });
  drawTable(doc, { title: "Navegador", dimensionLabel: "Navegador", dimensionKey: "browserName", exclude: ["browserName"], rows: byBrowser });
  drawTable(doc, { title: "Sistema operacional", dimensionLabel: "SO", dimensionKey: "osName", exclude: ["osName"], rows: byOS });

  if (capacity) {
    drawCapacitySection(doc, capacity);
  } else {
    ensureSpace(doc, 40);
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor(MUTED).font("Helvetica").text(
      "Capacidade da infraestrutura: não foi possível obter os dados desta vez.",
      doc.page.margins.left, doc.y, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  }

  doc.end();
  return done;
}

async function main() {
  const token = loadToken();
  if (!TEAM_ID) throw new Error("VERCEL_TEAM_ID not set");

  const { since, until, label: monthLabel } = last30DaysRange();
  const range = { since, until };

  const [byDay, byRoute, byCountry, byReferrer, byDevice, byBrowser, byOS] = await Promise.all([
    vercelQuery(token, "/visits/aggregate", { ...range, by: "day", limit: "100" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "route", limit: "20" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "country", limit: "20" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "referrerHostname", limit: "20" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "deviceType", limit: "10" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "browserName", limit: "10" }),
    vercelQuery(token, "/visits/aggregate", { ...range, by: "osName", limit: "10" }),
  ]);

  let capacity = null;
  try {
    capacity = await fetchCapacity();
  } catch (e) {
    console.error(`capacity fetch failed, report will omit that section: ${e.message}`);
  }

  const pdf = await buildReport({ since, until, label: monthLabel, byDay, byRoute, byCountry, byReferrer, byDevice, byBrowser, byOS, capacity });

  const totalVisitors = sumMetric(byDay, "visitors");
  const totalViews = sumMetric(byDay, "views");
  const filename = `nexusrota-analytics-${until.slice(0, 10)}.pdf`;
  const caption = `📊 <b>Relatório de Analytics da LP — ${monthLabel}</b>\nVisitantes: ${totalVisitors} · Page views: ${totalViews}`;

  await sendTelegramDocument(pdf, filename, caption);
  console.log(`report sent for ${monthLabel} (${totalVisitors} visitors, ${totalViews} views)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`analytics-report error: ${e.message}`);
    process.exit(1);
  });
}
