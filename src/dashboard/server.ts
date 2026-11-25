#!/usr/bin/env node
/**
 * Live dashboard server.
 *
 *   node dist/dashboard/server.js [--port 4747] [--host 127.0.0.1] [--token SECRET] [--db PATH]
 *
 * Opens the automaton's state DB read-only and serves a page that refreshes
 * every few seconds. Binds to localhost by default; binding to any other
 * host requires a token (passed as ?token=... in the URL).
 */

import crypto from "crypto";
import http from "http";
import path from "path";
import { pathToFileURL } from "url";
import Database from "better-sqlite3";
import { loadConfig, resolvePath } from "../config.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { buildDashboardState } from "./state.js";
import { DASHBOARD_HTML } from "./page.js";

export interface DashboardOptions {
  port: number;
  host: string;
  token?: string;
  dbPath?: string;
}

function parseArgs(argv: string[]): DashboardOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    port: Number(get("--port") ?? process.env.DASHBOARD_PORT ?? 4747),
    host: get("--host") ?? process.env.DASHBOARD_HOST ?? "127.0.0.1",
    token: get("--token") ?? process.env.DASHBOARD_TOKEN,
    dbPath: get("--db"),
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function tokenOk(expected: string | undefined, given: string | null): boolean {
  if (!expected) return true;
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createDashboardServer(opts: DashboardOptions): http.Server {
  const config = loadConfig();
  const dbPath = resolvePath(opts.dbPath ?? config?.dbPath ?? "~/.automaton/state.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const journalPath = path.join(getAutomatonDir(), "journal.md");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const secHeaders = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    };
    if (!tokenOk(opts.token, url.searchParams.get("token"))) {
      res.writeHead(401, { ...secHeaders, "Content-Type": "text/plain" });
      res.end("Unauthorized: add ?token=... to the URL");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, secHeaders);
      res.end();
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        ...secHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (url.pathname === "/api/state") {
      try {
        const state = buildDashboardState(db, {
          name: config?.name ?? "automaton",
          model: config?.inferenceModel ?? "",
          trading: config?.trading,
          journalPath,
        });
        res.writeHead(200, { ...secHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify(state));
      } catch (err: any) {
        res.writeHead(500, { ...secHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message ?? String(err) }));
      }
      return;
    }
    res.writeHead(404, secHeaders);
    res.end();
  });
  server.on("close", () => db.close());
  return server;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!isLoopback(opts.host) && !opts.token) {
    console.error(
      `Refusing to listen on ${opts.host} without a token. Use --token <secret> (or DASHBOARD_TOKEN), ` +
        "or keep the default 127.0.0.1 and use an SSH tunnel.",
    );
    process.exit(1);
  }
  let server: http.Server;
  try {
    server = createDashboardServer(opts);
  } catch (err: any) {
    console.error(`Cannot open the automaton database: ${err?.message ?? err}`);
    process.exit(1);
  }
  server.listen(opts.port, opts.host, () => {
    const q = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
    console.log(`Automaton live dashboard: http://${opts.host}:${opts.port}/${q}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
