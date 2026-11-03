// Fake MCP server with a tunable schema size — the calibration probe.
//   node test/fake-tax.mjs <toolCount> <descChars>
// Every tool is generated deterministically so the byte size is known exactly.

const N = Number(process.argv[2] ?? 10);
const DESC = Number(process.argv[3] ?? 200);
const pad = (n) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 28)).slice(0, n);

const TOOLS = Array.from({ length: N }, (_, i) => ({
  name: `tax_probe_${String(i).padStart(3, "0")}`,
  description: `Probe tool #${i}. ${pad(DESC)}`,
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: pad(Math.max(20, DESC / 4)) } },
    required: ["value"],
  },
}));

let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m);
  }
});

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function handle(m) {
  if (m.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-tax", version: "1" } },
    });
  }
  if (m.method === "tools/list") {
    process.stderr.write(`[fake-tax] ${TOOLS.length} tools, ${JSON.stringify(TOOLS).length} chars\n`);
    return send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  }
  if (m.method === "tools/call") {
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo:${m.params.name}` }] } });
  }
  if (m.id != null) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
}
