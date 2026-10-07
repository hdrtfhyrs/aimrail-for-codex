export * from '../../src/deliverables.mjs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../src/deliverables.mjs',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}
