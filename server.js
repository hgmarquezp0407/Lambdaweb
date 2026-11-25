const express = require("express");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const app = express();
const port = Number(process.env.PORT || 8080);
const tableName = process.env.DYNAMODB_TABLE_NAME;
const idKey = process.env.ERROR_ID_KEY || "errorId";
const allowedStatuses = new Set(["pending", "thinking", "answered"]);

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public", { etag: true, maxAge: "1h" }));

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/errors", async (request, response, next) => {
  if (!tableName) {
    return response.status(503).json({ error: "DYNAMODB_TABLE_NAME no está configurada." });
  }

  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const result = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        Limit: limit,
      }),
    );
    const errors = (result.Items || [])
      .filter((item) => item[idKey] !== undefined)
      .map((item) => ({
        ...item,
        errorId: item[idKey],
        status: allowedStatuses.has(item.status) ? item.status : "pending",
      }))
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

    response.json({ errors, hasMore: Boolean(result.LastEvaluatedKey) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/errors/:id/consult", async (request, response, next) => {
  if (!tableName) {
    return response.status(503).json({ error: "DYNAMODB_TABLE_NAME no está configurada." });
  }
  if (!process.env.AGENT_API_URL) {
    return response.status(503).json({ error: "AGENT_API_URL no está configurada." });
  }

  const keyValue = request.params.id;
  let consultationStarted = false;
  try {
    const itemResult = await dynamo.send(
      new GetCommand({
        TableName: tableName,
        Key: { [idKey]: keyValue },
      }),
    );
    if (!itemResult.Item) {
      return response.status(404).json({ error: "No se encontró el error solicitado." });
    }

    const item = itemResult.Item;
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { [idKey]: keyValue },
        UpdateExpression: "SET #status = :thinking, consultedAt = :consultedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":thinking": "thinking",
          ":consultedAt": new Date().toISOString(),
        },
      }),
    );
    consultationStarted = true;

    const agentResponse = await fetch(process.env.AGENT_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AGENT_API_TOKEN
          ? { authorization: `Bearer ${process.env.AGENT_API_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ error: item }),
      signal: AbortSignal.timeout(Number(process.env.AGENT_TIMEOUT_MS || 20000)),
    });

    if (!agentResponse.ok) {
      throw new Error(`El agente respondió HTTP ${agentResponse.status}.`);
    }
    const agentResult = await agentResponse.json();
    if (typeof agentResult.answer !== "string" || !agentResult.answer.trim()) {
      throw new Error("La respuesta del agente debe incluir el campo de texto answer.");
    }

    const answer = agentResult.answer.trim();
    const origin = typeof agentResult.origin === "string" ? agentResult.origin : "";
    const mermaid = typeof agentResult.mermaid === "string" ? agentResult.mermaid : "";
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { [idKey]: keyValue },
        UpdateExpression:
          "SET #status = :answered, agentResponse = :answer, agentOrigin = :origin, agentMermaid = :mermaid, answeredAt = :answeredAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":answered": "answered",
          ":answer": answer,
          ":origin": origin,
          ":mermaid": mermaid,
          ":answeredAt": new Date().toISOString(),
        },
      }),
    );

    response.json({
      error: {
        ...item,
        errorId: item[idKey],
        status: "answered",
        agentResponse: answer,
        agentOrigin: origin,
        agentMermaid: mermaid,
      },
    });
  } catch (error) {
    if (consultationStarted) {
      try {
        await dynamo.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { [idKey]: keyValue },
            UpdateExpression: "SET #status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":pending": "pending" },
          }),
        );
      } catch (resetError) {
        console.error("No se pudo restablecer el estado del incidente:", resetError);
      }
    }
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error("Error en la API:", error);
  response.status(502).json({ error: "No se pudo completar la operación solicitada." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Consola Lambda Web Adapter disponible en el puerto ${port}.`);
});
