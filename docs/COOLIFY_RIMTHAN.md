# Rimthan Coolify deployment

This fork is pinned for the Rimthan `claude-code-otel` pilot. The root
`docker-compose.yaml` is the Coolify deployment source of truth and intentionally
keeps all secrets in Coolify environment variables.

## Public endpoints

- OTLP Alloy receiver: `https://otel.telemetry.rimthan.army`
- Langfuse UI: `https://langfuse.telemetry.rimthan.army`

`alloy` is the public OTLP front door and requires the shared bearer token.
It routes logs and metrics to the internal `telemetry-bridge`, and traces to
Langfuse's OTLP endpoint. The bridge is still routed only for `/health`.
Postgres, ClickHouse, Redis, and MinIO remain internal to the compose network.

## Required Coolify env

```dotenv
OTEL_BRIDGE_API_KEY=<secret>

LANGFUSE_INIT_ORG_ID=<secret>
LANGFUSE_INIT_ORG_NAME=Rimthan
LANGFUSE_INIT_PROJECT_ID=<secret>
LANGFUSE_INIT_PROJECT_NAME=Claude Code OTEL
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=<secret>
LANGFUSE_INIT_PROJECT_SECRET_KEY=<secret>
LANGFUSE_INIT_USER_EMAIL=<admin-email>
LANGFUSE_INIT_USER_NAME=Rimthan Admin
LANGFUSE_INIT_USER_PASSWORD=<secret>

NEXTAUTH_SECRET=<secret>
LANGFUSE_SALT=<secret>
LANGFUSE_ENCRYPTION_KEY=<64-hex-chars>
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<secret>
POSTGRES_DB=postgres
CLICKHOUSE_USER=clickhouse
CLICKHOUSE_PASSWORD=<secret>
REDIS_AUTH=<secret>
MINIO_ROOT_USER=<secret>
MINIO_ROOT_PASSWORD=<secret>
LANGFUSE_S3_BUCKET=langfuse
LANGFUSE_TELEMETRY_ENABLED=false
LOG_LEVEL=info
SESSION_TIMEOUT=3600000
MAX_REQUEST_SIZE=10485760
```

## Claude Code pilot env

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL": "1",
    "CLAUDE_CODE_PROPAGATE_TRACEPARENT": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_METRIC_EXPORT_INTERVAL": "5000",
    "OTEL_LOGS_EXPORT_INTERVAL": "1000",
    "OTEL_TRACES_EXPORT_INTERVAL": "1000",
    "OTEL_RESOURCE_ATTRIBUTES": "deployment.environment=production,service.namespace=rimthan,team.name=rimthan,telemetry.pipeline=alloy-langfuse",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.telemetry.rimthan.army",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <OTEL_BRIDGE_API_KEY>",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "true",
    "OTEL_METRICS_INCLUDE_VERSION": "true",
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID": "true",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT": "true",
    "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES": "true",
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1",
    "OTEL_LOG_RAW_API_BODIES": "1"
  }
}
```

## Smoke checks

```bash
curl -fsS https://otel.telemetry.rimthan.army/health
curl -fsS https://langfuse.telemetry.rimthan.army/api/public/health

curl -i -X POST https://otel.telemetry.rimthan.army/v1/logs \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -fsS -X POST https://otel.telemetry.rimthan.army/v1/logs \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${OTEL_BRIDGE_API_KEY}" \
  -d '{"resourceLogs":[]}'

curl -fsS -X POST https://otel.telemetry.rimthan.army/v1/traces \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${OTEL_BRIDGE_API_KEY}" \
  -d '{"resourceSpans":[]}'
```
