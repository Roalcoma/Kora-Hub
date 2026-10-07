import { app } from './index.ts';

const port = Number(process.env.PORT ?? 4300);
app.listen(port, () => console.log(JSON.stringify({ level: 'info', msg: `API en http://localhost:${port}/api/v1` })));
