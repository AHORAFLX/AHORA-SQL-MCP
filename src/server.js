const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const pkg = require("../package.json");
const tools = require("./tools");
const resources = require("./resources");
const prompts = require("./prompts");

function createServer() {
  const server = new McpServer(
    { name: "ahora-sql-mcp", version: pkg.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );
  tools.registerAll(server);
  resources.registerAll(server);
  prompts.registerAll(server);
  return server;
}

module.exports = { createServer };
