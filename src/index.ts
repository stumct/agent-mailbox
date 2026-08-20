import { createMcpHandler } from "agents/mcp/server";
import { handleApi, hasMasterAccess } from "./api";
import { Mailbox } from "./mailbox";
import { createMailboxMcpServer } from "./mcp";
import { receiveEmail } from "./service";
import type { AppEnv } from "./types";

export { Mailbox };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      if (request.method !== "OPTIONS" && !(await hasMasterAccess(request, env))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return createMcpHandler(() => createMailboxMcpServer(env), {
        route: "/mcp",
        allowedHostnames: [env.MCP_HOSTNAME],
        allowedOriginHostnames: [env.MCP_HOSTNAME],
      })(request, env, ctx);
    }
    return handleApi(request, env);
  },

  email(message, env): Promise<void> {
    return receiveEmail(message, env);
  },
} satisfies ExportedHandler<AppEnv>;
