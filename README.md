# Lambda Web — Error Observatory

Consola web ligera para explorar errores almacenados en DynamoDB por servicio, categoría y criticidad, y solicitar un análisis a un agente externo. Está preparada como contenedor de AWS Lambda con Lambda Web Adapter.

## Desarrollo local

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Configura las variables de `.env.example` en tu entorno. AWS SDK utiliza la cadena de credenciales estándar de AWS; localmente puedes usar un perfil AWS o las variables de credenciales habituales.
4. Ejecuta `npm start` y abre `http://localhost:8080`.

La aplicación necesita `DYNAMODB_TABLE_NAME` y acceso IAM a `dynamodb:Scan`, `dynamodb:GetItem` y `dynamodb:UpdateItem`. La clave de partición se configura con `ERROR_ID_KEY` y por defecto es `errorId`. Los registros pueden incluir `service`, `category`, `criticality` (`critical`, `high`, `medium` o `low`), `message`, `timestamp`, `status`, `log`, `agentResponse`, `agentOrigin` y `agentMermaid`. Los estados de análisis son `pending`, `thinking` y `answered`.

Los diagramas Mermaid se cargan bajo demanda desde jsDelivr únicamente cuando un incidente seleccionado incluye un diagrama; si la librería no está disponible, se muestra el código fuente.

## Protocolo del agente

Configura `AGENT_API_URL` con un endpoint HTTP que reciba `POST` con `{ "error": <registro DynamoDB> }` y responda JSON con un campo `answer` de texto no vacío. Los campos opcionales `origin` y `mermaid` muestran respectivamente el origen detectado y un diagrama Mermaid en el panel lateral. Si se configura `AGENT_API_TOKEN`, se envía como token Bearer.

La consulta marca el registro como `thinking` mientras espera al proveedor; tras una respuesta válida, guarda el diagnóstico y lo marca como `answered`. Si el proveedor no está configurado o falla, la API notifica el error y no inventa una respuesta.

## Contenedor Lambda

Construye el contenedor con `docker build -t lambda-error-observatory .` y publícalo en ECR para desplegarlo como imagen de contenedor Lambda. Configura `DYNAMODB_TABLE_NAME`, `ERROR_ID_KEY` y las variables del agente en la configuración de la función. Concede a su rol de ejecución los permisos DynamoDB necesarios. Lambda Web Adapter sirve la aplicación Node en el puerto 8080 y comprueba su disponibilidad en `/health`.

La interfaz consulta hasta 100 registros por carga y se actualiza cada 15 segundos. Para tablas grandes o cargas de tráfico altas, conviene incorporar un índice y una estrategia de paginación adecuada al patrón de consulta de la aplicación.
