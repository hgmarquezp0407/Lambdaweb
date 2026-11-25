import boto3, json, random, time, uuid, os

logs = boto3.client("logs")
STREAM = f"gen-{time.strftime('%Y-%m-%d')}-{uuid.uuid4().hex[:6]}"

# Cada escenario pertenece a un log group (servicio)
ESCENARIOS = {
    "/app/demo-api": [
        [("INFO",    "Request recibido GET /api/orders"),
         ("WARNING", "Query lenta en PostgreSQL: 3200ms (umbral 1000ms)"),
         ("WARNING", "Pool de conexiones al 85% (17/20)"),
         ("ERROR",   "DBTimeout: query excedió 5000ms en tabla orders"),
         ("ERROR",   "GET /api/orders respondió 504 Gateway Timeout"),
         ("INFO",    "Pool de conexiones reiniciado"),
         ("INFO",    "GET /api/orders respondió 200 OK en 120ms")],
        [("WARNING", "Uso de memoria al 78%"),
         ("WARNING", "Uso de memoria al 91%, GC frecuente"),
         ("ERROR",   "OutOfMemoryError: heap agotado en worker-3"),
         ("ERROR",   "Contenedor terminado con exit code 137"),
         ("INFO",    "Contenedor reiniciado por el orquestador")],
    ],
    "/app/demo-auth": [
        [("INFO",    "Intento de login usuario=jperez"),
         ("WARNING", "Contraseña incorrecta usuario=jperez intento=1"),
         ("WARNING", "Contraseña incorrecta usuario=jperez intento=3"),
         ("ERROR",   "Cuenta bloqueada usuario=jperez tras 5 intentos fallidos")],
    ],
    "/app/demo-payments": [
        [("INFO",    "Procesando pago order_id=ORD-4821"),
         ("WARNING", "Stripe API respondió 429, reintento 1/3"),
         ("WARNING", "Stripe API respondió 503, reintento 2/3"),
         ("ERROR",   "Pago fallido order_id=ORD-4821: reintentos agotados"),
         ("INFO",    "Pago encolado para reproceso")],
    ],
}

def asegurar_stream(group):
    try:
        logs.create_log_stream(logGroupName=group, logStreamName=STREAM)
    except logs.exceptions.ResourceAlreadyExistsException:
        pass

def lambda_handler(event, context):
    for _ in range(3):
        group = random.choice(list(ESCENARIOS))
        escenario = random.choice(ESCENARIOS[group])
        req_id = uuid.uuid4().hex[:8]
        asegurar_stream(group)

        eventos = []
        ts = int(time.time() * 1000)
        for nivel, msg in escenario:
            ts += random.randint(100, 1500)  # timestamps crecientes y ordenados
            eventos.append({
                "timestamp": ts,
                "message": json.dumps({"level": nivel, "request_id": req_id,
                                       "service": group, "message": msg}),
            })
        logs.put_log_events(logGroupName=group, logStreamName=STREAM, logEvents=eventos)
    return {"status": "ok"}