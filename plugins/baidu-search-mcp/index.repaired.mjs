#!/usr/bin/env node
// Compatibility entrypoint backed by the shared search-tools implementation.
import { startServer } from '../search-tools/server.mjs';
const values=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')).map(x=>x.slice(2).split('=')));
await startServer({legacy:true,defaults:{...(values['max-result']?{count:Number(values['max-result'])}:{}),fetchCount:Number(values['fetch-content-count']||0),max_length:Number(values['max-content-length']||6000)}});
