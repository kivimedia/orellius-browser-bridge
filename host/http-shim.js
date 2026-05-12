import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = parseInt(process.env.ORELLIUS_HTTP_PORT || "18800", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = resolve(__dirname, "mcp-server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [MCP_SERVER_PATH],
  env: { ...process.env },
});

const client = new Client(
  { name: "orellius-http-shim", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);
const { tools } = await client.listTools();
console.error(`[shim] Connected to Orellius MCP. ${tools.length} tools available.`);

function unwrap(mcpResponse) {
  const content = mcpResponse?.content;
  if (!Array.isArray(content) || content.length === 0) return mcpResponse;
  const first = content[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try { return JSON.parse(first.text); } catch { return first.text; }
  }
  return content;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tools: tools.length }));
    return;
  }

  if (req.method === "POST" && req.url === "/tool") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { tool, args } = JSON.parse(body);
        const mcpResp = await client.callTool({ name: tool, arguments: args || {} });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: unwrap(mcpResp), isError: !!mcpResp.isError }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[shim] HTTP shim listening on http://127.0.0.1:${PORT}`);
});

async function shutdown() {
  console.error("[shim] Shutting down...");
  server.close();
  try { await client.close(); } catch {}
  try { await transport.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
