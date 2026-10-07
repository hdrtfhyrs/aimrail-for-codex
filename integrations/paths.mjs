import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WORKSPACE} from '../src/paths.mjs';
import {publicPath} from '../modules/system/public-paths.mjs';
export const REPOSITORY = path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const HOST_HOME = path.resolve(process.env.AI_CODEX_HOME || path.join(REPOSITORY,'integrations'));
export function integrationPath(key) {
 if(key==='python')return process.env.AI_PYTHON || 'python';
 if(key==='workspace')return WORKSPACE;
 if(key.startsWith('workspace/'))return path.join(WORKSPACE,key.slice(10));
 if(key==='integrations')return HOST_HOME;
 if(key.startsWith('integrations/context/')){
   const rel=key.slice('integrations/context/'.length);
   if(rel==='bindings'||rel.startsWith('bindings/'))return path.join(WORKSPACE,rel);
   if(rel==='recall-cache'||rel.startsWith('recall-cache/'))return path.join(WORKSPACE,'.cache','recall-system',rel.slice('recall-cache'.length));
   return rel.endsWith('.mjs')?path.join(HOST_HOME,'context',rel):path.join(WORKSPACE,'integrations','context',rel);
 }
 if(key.startsWith('integrations/'))return publicPath('$codex/'+key.slice(13));
 if(key.startsWith('modules/system/'))return publicPath('$system/'+key.slice('modules/system/'.length));
 return path.join(REPOSITORY,key);
}
