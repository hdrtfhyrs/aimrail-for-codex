import {integrationPath} from '../paths.mjs';
const location=process.env.AI_METHODS_ENTRY;if(!location)throw Error('Set AI_METHODS_ENTRY to your methods-library module');
const {main}=await import(location.startsWith('file:')?location:(await import('node:url')).pathToFileURL(location).href);
const args=process.argv.slice(2);
if(args.length&&args[0]!=='help'&&!args.includes('--directory'))args.push('--directory',integrationPath("workspace/memory/knowledge/方法与演进库"));
try{await main(args)}catch(e){console.error(e.message);process.exitCode=1}
