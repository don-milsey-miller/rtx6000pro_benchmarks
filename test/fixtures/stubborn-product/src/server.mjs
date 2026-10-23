import { createServer } from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === "/never") return;
  if (request.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {}\n\n");
    return;
  }
  response.writeHead(404).end();
});

process.on("SIGTERM", () => {});
server.listen(port, host);
