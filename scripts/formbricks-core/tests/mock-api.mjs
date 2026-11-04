import http from "node:http";

const port = Number(process.env.MOCK_PORT || 18080);
const surveys = new Map();
let sequence = 0;

function send(response, status, body, contentType = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": contentType,
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && ["/health", "/api/v2/health"].includes(url.pathname)) {
    return send(response, 200, { data: { main_database: true, cache_database: true } });
  }
  if (request.method === "GET" && /^\/s\/[^/]+$/.test(url.pathname)) {
    return send(response, 200, "<!doctype html><html><body>Mock survey</body></html>", "text/html");
  }
  if (request.method === "GET" && /^\/api\/v1\/client\/[^/]+\/environment$/.test(url.pathname)) {
    return send(response, 200, { data: { surveys: [] } });
  }
  if (request.method === "POST" && /^\/api\/v1\/client\/[^/]+\/responses$/.test(url.pathname)) {
    await readJson(request);
    sequence += 1;
    return send(response, 200, { data: { id: `response${sequence.toString().padStart(16, "0")}` } });
  }
  if (url.pathname === "/api/v3/surveys" && request.method === "POST") {
    const body = await readJson(request);
    sequence += 1;
    const survey = {
      id: `survey${sequence.toString().padStart(18, "0")}`,
      name: body.name,
      workspaceId: body.workspaceId,
    };
    surveys.set(survey.id, survey);
    return send(response, 201, { data: survey });
  }
  if (url.pathname === "/api/v3/surveys" && request.method === "GET") {
    const nameFilter = url.searchParams.get("filter[name][contains]");
    const data = [...surveys.values()].filter((survey) => !nameFilter || survey.name.includes(nameFilter));
    return send(response, 200, { data, meta: { nextCursor: null } });
  }

  const surveyMatch = url.pathname.match(/^\/api\/v3\/surveys\/([^/]+)$/);
  if (surveyMatch && request.method === "GET") {
    const survey = surveys.get(surveyMatch[1]);
    return survey ? send(response, 200, { data: survey }) : send(response, 404, { error: "not found" });
  }
  if (surveyMatch && request.method === "DELETE") {
    surveys.delete(surveyMatch[1]);
    response.writeHead(204);
    return response.end();
  }

  return send(response, 404, { error: `${request.method} ${url.pathname}` });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock API listening on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
