import { createServer } from 'node:http';
import { app } from './index.ts';
import { attachRealtime } from './realtime/hub.ts';
import { startWorker } from './jobs/worker.ts';
import { ensureBucket } from './files/s3.ts';

const port = Number(process.env.PORT ?? 4300);
const server = createServer(app);
attachRealtime(server);
await ensureBucket().catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'S3 no disponible', error: err.message })));
startWorker();
server.listen(port, () => console.log(JSON.stringify({ level: 'info', msg: `API en http://localhost:${port}/api/v1 · WebSocket en /ws` })));
