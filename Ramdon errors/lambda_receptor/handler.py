import base64, gzip, json, os, time
from datetime import datetime, timezone
import boto3

table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])

def lambda_handler(event, context):
    payload = base64.b64decode(event["awslogs"]["data"])
    data = json.loads(gzip.decompress(payload))

    with table.batch_writer() as batch:
        for e in data["logEvents"]:
            log = json.loads(e["message"])
            ts = datetime.fromtimestamp(e["timestamp"] / 1000, tz=timezone.utc).isoformat()
            batch.put_item(Item={
                "service":    data["logGroup"],            # PK
                "sk":         f"{ts}#{e['id']}",           # SK (orden cronológico + único)
                "request_id": log.get("request_id", "N/A"),
                "level":      log.get("level"),
                "message":    log.get("message"),
                "log_stream": data["logStream"],
                "expires_at": int(time.time()) + 7 * 86400,  # TTL 7 días
            })
    return {"guardados": len(data["logEvents"])}